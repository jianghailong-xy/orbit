package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// The reset step (codex_rate_limit_reset_consume.go) through the relay that hands it its commands, named
// in scripts/test-codex-reset-consume.sh. Its provider is a programmable fake `codex app-server`: this
// test binary behind a shim, spawned exactly as the step spawns Codex, serving an account whose credits,
// resettable window and already-redeemed keys live in a file — so that, like the real backend, they
// outlive every app-server process, and a key that completed a reset is answered alreadyRedeemed by
// whichever process asks. Its control plane keeps one operation the way @orbit/shared does. Nothing here
// reaches a real Codex account or spends a real credit.

const fakeCodexResetProviderEnv = "ORBIT_FAKE_CODEX_RESET_PROVIDER"

const (
	codexResetTestAccountID    = "acct_fixture_primary"
	codexResetTestOtherAccount = "acct_fixture_other"
	codexResetProviderFile     = "provider.json"
	codexResetEventLog         = "events.jsonl"
)

// The requests of one read on a fresh app-server: its handshake, then account/read and
// account/rateLimits/read.
var codexResetReadRequests = []string{"app initialize", "app initialized", "app " + codexAccountReadMethod, "app " + codexRateLimitsReadMethod}

// ---------------------------------------------------------------------------
// the provider
// ---------------------------------------------------------------------------

// codexResetProviderState is the provider behind the fake app-server.
type codexResetProviderState struct {
	// account/read's account: a ChatGPT login, {"type":"apiKey"}, or nil when signed out.
	Account map[string]interface{} `json:"account"`
	// account/rateLimits/read's accountId; nil sends null.
	AccountID *string `json:"accountId"`
	// An older CLI, whose account/rateLimits/read has no rateLimitResetCredits key.
	NoResetCredits bool  `json:"noResetCredits"`
	AvailableCount int64 `json:"availableCount"`
	// Whether a current window can be reset; a reset uses it up.
	Resettable bool `json:"resettable"`
	// The keys whose consume completed a reset, in order.
	Redeemed []string `json:"redeemed"`
	// What each consume call that reached the account was answered, in order.
	Answers []string                  `json:"answers"`
	Faults  []codexResetProviderFault `json:"faults"`
}

// codexResetProviderFault is what one request goes through instead of its ordinary answer: the first
// fault naming the request's method, once Skip earlier requests of that method have gone past it.
type codexResetProviderFault struct {
	Method string `json:"method"`
	Skip   int    `json:"skip,omitempty"`
	// error: a JSON-RPC error. garbage: a result that is no outcome. hang: no answer. exit: the
	// app-server dies unanswered. spendThenHang, spendThenExit: the consume spends as it would, and its
	// answer never leaves.
	Do string `json:"do"`
}

// codexResetSignedIn is the operation's own ChatGPT account holding count credits.
func codexResetSignedIn(count int64, resettable bool) codexResetProviderState {
	accountID := codexResetTestAccountID
	return codexResetProviderState{
		Account:        map[string]interface{}{"type": "chatgpt", "email": codexResetTestEmail, "planType": "pro"},
		AccountID:      &accountID,
		AvailableCount: count,
		Resettable:     resettable,
	}
}

func (s *codexResetProviderState) fault(method string) string {
	for i := range s.Faults {
		if s.Faults[i].Method != method {
			continue
		}
		if s.Faults[i].Skip > 0 {
			s.Faults[i].Skip--
			return ""
		}
		do := s.Faults[i].Do
		s.Faults = append(s.Faults[:i], s.Faults[i+1:]...)
		return do
	}
	return ""
}

// consume is the provider's rule for one key (§1.2): a key that completed a reset is answered
// alreadyRedeemed and spends nothing; any other key resets a resettable window with a credit it has.
func (s *codexResetProviderState) consume(key string) string {
	for _, redeemed := range s.Redeemed {
		if redeemed == key {
			return "alreadyRedeemed"
		}
	}
	switch {
	case s.AvailableCount == 0:
		return "noCredit"
	case !s.Resettable:
		return "nothingToReset"
	}
	s.AvailableCount--
	s.Resettable = false
	s.Redeemed = append(s.Redeemed, key)
	return "reset"
}

func (s *codexResetProviderState) rateLimits() map[string]interface{} {
	used := 20.0
	if s.Resettable {
		used = 100
	}
	answer := map[string]interface{}{
		"rateLimits": map[string]interface{}{
			"limitId": codexPlanLimitID,
			"primary": map[string]interface{}{"usedPercent": used, "windowDurationMins": 300},
		},
		"accountId": s.AccountID,
	}
	if !s.NoResetCredits {
		answer["rateLimitResetCredits"] = map[string]interface{}{"availableCount": s.AvailableCount, "credits": nil}
	}
	return answer
}

// codexResetUpdateProvider reads the provider's state from dir, lets change edit it and writes it back,
// under the lock every fake app-server process and the test take.
func codexResetUpdateProvider(dir string, change func(*codexResetProviderState)) error {
	unlock, err := acquireCodexStateInitFileLock(context.Background(), filepath.Join(dir, "provider.lock"))
	if err != nil {
		return err
	}
	defer unlock()
	path := filepath.Join(dir, codexResetProviderFile)
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var state codexResetProviderState
	if err := json.Unmarshal(data, &state); err != nil {
		return err
	}
	change(&state)
	if data, err = json.Marshal(state); err != nil {
		return err
	}
	if err := os.WriteFile(path+".tmp", data, 0o644); err != nil {
		return err
	}
	return os.Rename(path+".tmp", path)
}

// runFakeCodexResetProvider is `codex app-server --stdio` for the consume tests' shim. Its start and
// every frame it hears go to the event log in dir, with the answer, before anything is answered, so the
// log's order is the order things happened in.
func runFakeCodexResetProvider(dir string) int {
	log := filepath.Join(dir, codexResetEventLog)
	appendJSONL(log, codexResetEvent{Src: "app", Pid: os.Getpid(), Spawn: true})
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		var frame struct {
			ID     interface{}     `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal(scanner.Bytes(), &frame) != nil {
			continue
		}
		event := codexResetEvent{Src: "app", Pid: os.Getpid(), Method: frame.Method, Params: frame.Params}
		if frame.ID == nil {
			appendJSONL(log, event)
			continue
		}
		reply := map[string]interface{}{"id": frame.ID}
		err := codexResetUpdateProvider(dir, func(state *codexResetProviderState) {
			event.Answer = state.fault(frame.Method)
			switch frame.Method {
			case "initialize":
				reply["result"] = map[string]interface{}{"userAgent": "fake-codex/0.154.0"}
			case codexAccountReadMethod:
				reply["result"] = map[string]interface{}{"account": state.Account, "requiresOpenaiAuth": false}
			case codexRateLimitsReadMethod:
				reply["result"] = state.rateLimits()
			case codexRateLimitResetConsumeMethod:
				if event.Answer != "" && !strings.HasPrefix(event.Answer, "spendThen") {
					return
				}
				var params struct {
					IdempotencyKey string `json:"idempotencyKey"`
				}
				_ = json.Unmarshal(frame.Params, &params)
				outcome := state.consume(params.IdempotencyKey)
				state.Answers = append(state.Answers, outcome)
				reply["result"] = map[string]interface{}{"outcome": outcome}
				if event.Answer == "" {
					event.Answer = outcome
				}
			default:
				reply["error"] = map[string]interface{}{"code": -32600, "message": "the fake app-server does not answer " + frame.Method}
			}
		})
		if err != nil {
			event.Answer = "provider state unreadable: " + err.Error()
			reply = map[string]interface{}{"id": frame.ID, "error": map[string]interface{}{"code": -32603, "message": event.Answer}}
		}
		appendJSONL(log, event)
		switch event.Answer {
		case "hang", "spendThenHang":
			continue
		case "exit", "spendThenExit":
			return 3
		case "error":
			delete(reply, "result")
			reply["error"] = map[string]interface{}{"code": -32600, "message": "the fake provider refused " + frame.Method}
		case "garbage":
			reply["result"] = map[string]interface{}{"outcome": "deferred"}
		}
		data, _ := json.Marshal(reply)
		if _, err := os.Stdout.Write(append(data, '\n')); err != nil {
			return 1
		}
	}
	return 0
}

// codexResetEvent is one line of the event log the fake app-servers, the control plane and the test all
// append to: whichever wrote first happened first.
type codexResetEvent struct {
	Src string `json:"src"` // app | cp | test

	// app: its start, or one frame it heard and what it answered — the outcome, or the fault the request
	// went through.
	Pid    int             `json:"pid,omitempty"`
	Spawn  bool            `json:"spawn,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Answer string          `json:"answer,omitempty"`

	// cp: a delivery, or one result and what became of it.
	Delivered  string          `json:"delivered,omitempty"`
	LeaseOwner string          `json:"leaseOwner,omitempty"`
	Generation int64           `json:"generation,omitempty"`
	Kind       string          `json:"kind,omitempty"`
	Detail     string          `json:"detail,omitempty"`
	Receipt    string          `json:"receipt,omitempty"`
	Result     json.RawMessage `json:"result,omitempty"`

	Mark string `json:"mark,omitempty"`
}

// ---------------------------------------------------------------------------
// the control plane
// ---------------------------------------------------------------------------

// codexResetModel is the control plane of the consume tests: one operation of one runner, dispatched and
// settled as @orbit/shared's decideCodexResetDispatch and applyCodexResetResult do it (§6.2, §6.3, §7),
// behind the real result route. It leaves out what no test here reaches: deadlines, the stored block's
// account, the capability and draining. A stop holds one result at the route, before it is applied or
// after, until the test releases it or its sender is gone — the result a crash never delivered, or the
// receipt a crash never read.
type codexResetModel struct {
	t         *testing.T
	log       string
	clock     *codexResetTestClock
	takeover  time.Duration
	createdAt string
	closed    chan struct{}

	mu    sync.Mutex
	op    codexResetModelOperation
	stops []*codexResetStop
	lose  map[string]int
}

// codexResetModelOperation is the operation row: its checkpoints and its claim.
type codexResetModelOperation struct {
	ID, AccountFingerprint, ProviderIdempotencyKey string
	ConsumeState, ConsumeOutcome, RefreshState     string
	FailureCode, LastErrorCode                     string
	ClaimLeaseOwner                                string
	ClaimGeneration, ClaimsWithUnknownCall         int64
	ClaimedAt                                      time.Time
}

// codexResetStop holds the next result of kind at the route: before it is applied, or after.
type codexResetStop struct {
	kind    string
	applied bool
	reached chan struct{}
	release chan struct{}
}

func newCodexResetModel(t *testing.T, log string, clock *codexResetTestClock, fingerprint string) *codexResetModel {
	t.Helper()
	id, err := newLeaseGeneration()
	if err != nil {
		t.Fatal(err)
	}
	key, err := newLeaseGeneration()
	if err != nil {
		t.Fatal(err)
	}
	return &codexResetModel{
		t:         t,
		log:       log,
		clock:     clock,
		takeover:  time.Duration(loadCodexResetContract(t).Timing["claimTakeoverAfterMs"]) * time.Millisecond,
		createdAt: clock.now().UTC().Format(codexResetFetchedAtLayout),
		closed:    make(chan struct{}),
		op: codexResetModelOperation{
			ID: id, AccountFingerprint: fingerprint, ProviderIdempotencyKey: key,
			ConsumeState: "PENDING", RefreshState: "NONE",
		},
		lose: map[string]int{},
	}
}

func (op codexResetModelOperation) phase() string {
	switch {
	case op.ConsumeState == "PENDING" || op.ConsumeState == "CLAIMED":
		return codexResetPhaseConsume
	case op.ConsumeState == "CONFIRMED" && op.RefreshState == "PENDING":
		return codexResetPhaseRefresh
	}
	return ""
}

func (op codexResetModelOperation) status() string {
	var outcome *string
	if op.ConsumeOutcome != "" {
		outcome = &op.ConsumeOutcome
	}
	return codexResetOperationStatus(op.ConsumeState, outcome, op.RefreshState)
}

func (m *codexResetModel) operation() codexResetModelOperation {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.op
}

func (m *codexResetModel) edit(change func(*codexResetModelOperation)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	change(&m.op)
}

// stopAt holds the next result of kind at the route, before it is applied or after.
func (m *codexResetModel) stopAt(kind string, applied bool) *codexResetStop {
	stop := &codexResetStop{kind: kind, applied: applied, reached: make(chan struct{}), release: make(chan struct{})}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stops = append(m.stops, stop)
	return stop
}

// loseReceipts drops the connection of the next n results of kind once they are applied.
func (m *codexResetModel) loseReceipts(kind string, n int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.lose[kind] += n
}

func (s *codexResetStop) await(t *testing.T) {
	t.Helper()
	select {
	case <-s.reached:
	case <-time.After(60 * time.Second):
		t.Fatalf("no %s result reached the control plane", s.kind)
	}
}

// dispatch is what one heartbeat of process leaseOwner is handed (decideCodexResetDispatch): the
// operation's command once its claim is, or becomes, that process's. A claim another process took less
// than claimTakeoverAfterMs ago stays that process's.
func (m *codexResetModel) dispatch(leaseOwner string) *CodexRateLimitResetCommand {
	m.mu.Lock()
	defer m.mu.Unlock()
	op := &m.op
	phase := op.phase()
	if phase == "" {
		return nil
	}
	now := m.clock.now()
	if op.ClaimLeaseOwner != leaseOwner {
		if op.ClaimLeaseOwner != "" && now.Before(op.ClaimedAt.Add(m.takeover)) {
			return nil
		}
		if op.ConsumeState == "PENDING" {
			op.ConsumeState = "CLAIMED"
		}
		op.ClaimLeaseOwner, op.ClaimGeneration, op.ClaimedAt = leaseOwner, op.ClaimGeneration+1, now
		if phase == codexResetPhaseConsume {
			op.ClaimsWithUnknownCall++
		}
	}
	cmd := CodexRateLimitResetCommand{
		ProtocolVersion:    codexRateLimitResetProtocolVersion,
		OperationID:        op.ID,
		LeaseOwner:         leaseOwner,
		ClaimGeneration:    op.ClaimGeneration,
		Phase:              phase,
		AccountFingerprint: op.AccountFingerprint,
		RequestedAt:        m.createdAt,
	}
	if phase == codexResetPhaseConsume {
		cmd.ProviderIdempotencyKey = op.ProviderIdempotencyKey
	}
	appendJSONL(m.log, codexResetEvent{Src: "cp", Delivered: phase, LeaseOwner: leaseOwner, Generation: cmd.ClaimGeneration})
	return &cmd
}

func (m *codexResetModel) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.URL.Path != "/api"+codexResetResultPath {
		http.NotFound(w, r)
		return
	}
	body, _ := io.ReadAll(r.Body)
	result, err := decodeCodexResetWire(body, codexResetResultViolations)
	if err != nil {
		m.t.Errorf("the step sent something that is not a protocol v1 result: %v\n%s", err, body)
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"code":"INVALID_RESULT"}`)
		return
	}
	event := codexResetEvent{
		Src: "cp", Kind: result.Kind, Detail: result.Outcome + result.Code,
		LeaseOwner: result.LeaseOwner, Generation: result.ClaimGeneration, Result: body,
	}
	if stop := m.takeStop(result.Kind, false); stop != nil {
		event.Receipt = "held before applying"
		if !m.hold(r, stop, event) {
			return // its sender is gone: this result never arrived
		}
	}
	m.mu.Lock()
	status, answer := m.apply(result)
	if m.op.status() == "" {
		m.t.Errorf("result %s left the operation in no status the contract derives: %+v", body, m.op)
	}
	lost := status == http.StatusOK && m.lose[result.Kind] > 0
	if lost {
		m.lose[result.Kind]--
	}
	m.mu.Unlock()
	switch receipt := answer.(type) {
	case CodexRateLimitResetResultResponse:
		event.Receipt = receipt.Disposition + " " + receipt.Status + " " + receipt.Next
	case CodexRateLimitResetResultRefusal:
		event.Receipt = "refused " + receipt.Code
	}
	switch stop := m.takeStop(result.Kind, true); {
	case lost:
		event.Receipt += " (receipt lost)"
		appendJSONL(m.log, event)
		codexResetLostReceipt(w)
		return
	case stop != nil:
		event.Receipt += " (held)"
		if !m.hold(r, stop, event) {
			return // its sender is gone before it read the receipt
		}
	default:
		appendJSONL(m.log, event)
	}
	data, _ := json.Marshal(answer)
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

func (m *codexResetModel) takeStop(kind string, applied bool) *codexResetStop {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, stop := range m.stops {
		if stop.kind == kind && stop.applied == applied {
			m.stops = append(m.stops[:i], m.stops[i+1:]...)
			return stop
		}
	}
	return nil
}

// hold logs event, lets the test know the stop is reached and waits for its release: false when the
// sender went away first.
func (m *codexResetModel) hold(r *http.Request, stop *codexResetStop, event codexResetEvent) bool {
	appendJSONL(m.log, event)
	close(stop.reached)
	select {
	case <-stop.release:
		return r.Context().Err() == nil
	case <-r.Context().Done():
		return false
	case <-m.closed:
		return false
	}
}

// apply is applyCodexResetResult on the model's operation, as the HTTP status and body the route answers.
func (m *codexResetModel) apply(r CodexRateLimitResetResultRequest) (int, interface{}) {
	op := &m.op
	refuse := func(status int, code string) (int, interface{}) {
		return status, CodexRateLimitResetResultRefusal{Code: code}
	}
	if r.OperationID != op.ID {
		return refuse(http.StatusNotFound, "OPERATION_NOT_FOUND")
	}
	current := r.LeaseOwner == op.ClaimLeaseOwner && r.ClaimGeneration == op.ClaimGeneration
	switch m.recordedFact(r) {
	case "CONFLICT":
		return refuse(http.StatusConflict, "OUTCOME_CONFLICT")
	case "SAME":
		return http.StatusOK, m.receipt("DUPLICATE", current)
	}
	phase := op.phase()
	switch {
	case phase == "":
		return refuse(http.StatusConflict, "OPERATION_SETTLED")
	case !current:
		return refuse(http.StatusConflict, "STALE_CLAIM")
	case r.Phase != phase:
		return refuse(http.StatusConflict, "PHASE_MISMATCH")
	}
	switch r.Kind {
	case "CONSUME_OUTCOME":
		op.ConsumeState, op.ConsumeOutcome, op.RefreshState, op.LastErrorCode = "CONFIRMED", r.Outcome, "NOT_REQUIRED", ""
		if codexRateLimitResetOutcomeEffects[r.Outcome].RefreshRequired {
			op.RefreshState = "PENDING"
		}
	case "CONSUME_NOT_CALLED":
		op.ClaimsWithUnknownCall = max(0, op.ClaimsWithUnknownCall-1)
		op.ConsumeState = "UNRESOLVED"
		if op.ClaimsWithUnknownCall == 0 {
			op.ConsumeState = "NOT_ATTEMPTED"
		}
		op.RefreshState, op.FailureCode = "NOT_REQUIRED", r.Code
	case "CONSUME_RETRYING":
		op.LastErrorCode = r.Code
	case "RELEASED":
		if phase == codexResetPhaseConsume {
			op.ClaimsWithUnknownCall = max(0, op.ClaimsWithUnknownCall-1)
		}
		op.ClaimLeaseOwner, op.ClaimedAt, op.LastErrorCode = "", time.Time{}, r.Code
	case "REFRESHED":
		if r.RateLimitReset.AccountFingerprint != op.AccountFingerprint {
			return refuse(http.StatusConflict, "ACCOUNT_MISMATCH")
		}
		op.RefreshState, op.LastErrorCode = "SUCCEEDED", ""
	case "REFRESH_FAILED":
		if codexResetOneOf(codexRateLimitResetResultKinds["REFRESH_FAILED"].TerminalCodes, r.Code) {
			op.RefreshState, op.FailureCode = "FAILED", r.Code
		} else {
			op.LastErrorCode = r.Code
		}
	}
	return http.StatusOK, m.receipt("APPLIED", true)
}

// recordedFact is SAME when r restates a fact the operation already holds, from whichever claim,
// CONFLICT when it contradicts one, and NEW otherwise.
func (m *codexResetModel) recordedFact(r CodexRateLimitResetResultRequest) string {
	op := m.op
	switch r.Kind {
	case "CONSUME_OUTCOME":
		if op.ConsumeState != "CONFIRMED" {
			return "NEW"
		}
		if r.Outcome == op.ConsumeOutcome ||
			(codexRateLimitResetOutcomeEffects[r.Outcome].Consumed && codexRateLimitResetOutcomeEffects[op.ConsumeOutcome].Consumed) {
			return "SAME"
		}
		return "CONFLICT"
	case "CONSUME_NOT_CALLED":
		if (op.ConsumeState == "NOT_ATTEMPTED" || op.ConsumeState == "UNRESOLVED") && op.FailureCode == r.Code {
			return "SAME"
		}
	case "REFRESHED":
		if op.RefreshState == "SUCCEEDED" && r.RateLimitReset.AccountFingerprint == op.AccountFingerprint {
			return "SAME"
		}
	case "REFRESH_FAILED":
		if op.RefreshState == "FAILED" && op.FailureCode == r.Code {
			return "SAME"
		}
	}
	return "NEW"
}

// receipt is codexResetNextStep for the claim that sent the result, and STOP for any other.
func (m *codexResetModel) receipt(disposition string, current bool) CodexRateLimitResetResultResponse {
	op := m.op
	next := "STOP"
	if current && op.ClaimLeaseOwner != "" {
		switch op.status() {
		case "CONSUMING":
			next = "RETRY_CONSUME"
		case "REFRESHING":
			next = "REFRESH"
			if op.LastErrorCode != "" {
				next = "RETRY_REFRESH"
			}
		}
	}
	return CodexRateLimitResetResultResponse{Disposition: disposition, Status: op.status(), Next: next}
}

// ---------------------------------------------------------------------------
// the machine and its runner processes
// ---------------------------------------------------------------------------

// codexResetHarness is one runner machine: the fake provider first on PATH, private machine and user
// homes, the control plane serving the operation, and a clock the relay and the step wait on without
// sleeping.
type codexResetHarness struct {
	t      *testing.T
	dir    string // the provider's state and the event log
	cp     *codexResetModel
	server *httptest.Server
	clock  *codexResetTestClock
	key    []byte // this machine's fingerprint key
}

func newCodexResetHarness(t *testing.T, provider codexResetProviderState) *codexResetHarness {
	t.Helper()
	base := t.TempDir()
	fake := &fakeCodexBinary{bin: filepath.Join(base, "bin"), dir: filepath.Join(base, "provider")}
	for _, dir := range []string{fake.bin, fake.dir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	state, err := json.Marshal(provider)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fake.dir, codexResetProviderFile), state, 0o644); err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	shim := "#!/bin/sh\n" + fakeCodexResetProviderEnv + "='" + fake.dir + "' exec '" + self + "' \"$@\"\n"
	if err := os.WriteFile(filepath.Join(fake.bin, "codex"), []byte(shim), 0o755); err != nil {
		t.Fatal(err)
	}
	fake.useAsRunnerDefault(t)

	// The shared state partition's one-time bootstrap starts an app-server of its own. Made here, it is
	// not one a test counts.
	env := os.Environ()
	cwd, _ := os.Getwd()
	selection, err := codexPlanUsageStateForEnv(env, cwd)
	if err != nil {
		t.Fatal(err)
	}
	if err := ensureSharedCodexStateReady(context.Background(), context.Background(), selection, env); err != nil {
		t.Fatalf("shared codex state bootstrap: %v", err)
	}
	if err := os.Remove(filepath.Join(fake.dir, codexResetEventLog)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		t.Fatal(err)
	}

	key, err := loadCodexAccountFingerprintKey()
	if err != nil {
		t.Fatal(err)
	}
	clock := &codexResetTestClock{at: time.Now()}
	cp := newCodexResetModel(t, filepath.Join(fake.dir, codexResetEventLog), clock, codexAccountFingerprint(key, codexResetTestAccountID))
	server := httptest.NewServer(cp)
	t.Cleanup(func() {
		close(cp.closed)
		server.Close()
	})
	return &codexResetHarness{t: t, dir: fake.dir, cp: cp, server: server, clock: clock, key: key}
}

func (c *codexResetTestClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.at = c.at.Add(d)
}

// provider applies change (when there is one) to the provider's state and returns the state.
func (h *codexResetHarness) provider(change func(*codexResetProviderState)) codexResetProviderState {
	h.t.Helper()
	var snapshot codexResetProviderState
	if err := codexResetUpdateProvider(h.dir, func(state *codexResetProviderState) {
		if change != nil {
			change(state)
		}
		snapshot = *state
	}); err != nil {
		h.t.Fatal(err)
	}
	return snapshot
}

func (h *codexResetHarness) mark(text string) {
	appendJSONL(filepath.Join(h.dir, codexResetEventLog), codexResetEvent{Src: "test", Mark: text})
}

// events reads the event log. The last line is skipped unless it is complete, since a writer may be
// appending it.
func (h *codexResetHarness) events() []codexResetEvent {
	h.t.Helper()
	data, err := os.ReadFile(filepath.Join(h.dir, codexResetEventLog))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		h.t.Fatal(err)
	}
	lines := bytes.Split(data, []byte("\n"))
	var out []codexResetEvent
	for _, line := range lines[:len(lines)-1] {
		var event codexResetEvent
		if err := json.Unmarshal(line, &event); err != nil {
			h.t.Fatalf("event log line %q: %v", line, err)
		}
		out = append(out, event)
	}
	return out
}

func (h *codexResetHarness) waitFor(what string, match func(codexResetEvent) bool) {
	h.t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	for {
		for _, event := range h.events() {
			if match(event) {
				return
			}
		}
		if time.Now().After(deadline) {
			h.t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// requireOnlyThePersistedKey fails unless every consume the app-servers heard carried exactly the
// operation's persisted key and nothing else, and returns how many there were.
func (h *codexResetHarness) requireOnlyThePersistedKey(events []codexResetEvent) int {
	h.t.Helper()
	want := map[string]interface{}{"idempotencyKey": h.cp.operation().ProviderIdempotencyKey}
	calls := codexResetConsumeCalls(h.t, events)
	for i, params := range calls {
		if !reflect.DeepEqual(params, want) {
			h.t.Fatalf("consume call %d sent %v, want only the operation's persisted key %v", i+1, params, want)
		}
	}
	return len(calls)
}

// results are the results the control plane took, in order: every one that was not held back unapplied.
func (h *codexResetHarness) results(events []codexResetEvent) []CodexRateLimitResetResultRequest {
	h.t.Helper()
	var out []CodexRateLimitResetResultRequest
	for _, event := range events {
		if event.Src != "cp" || event.Kind == "" || event.Receipt == "held before applying" {
			continue
		}
		var result CodexRateLimitResetResultRequest
		if err := json.Unmarshal(event.Result, &result); err != nil {
			h.t.Fatal(err)
		}
		out = append(out, result)
	}
	return out
}

func codexResetConsumeCalls(t *testing.T, events []codexResetEvent) []map[string]interface{} {
	t.Helper()
	var out []map[string]interface{}
	for _, event := range events {
		if event.Src != "app" || event.Method != codexRateLimitResetConsumeMethod {
			continue
		}
		var params map[string]interface{}
		if err := json.Unmarshal(event.Params, &params); err != nil {
			t.Fatalf("consume params %s: %v", event.Params, err)
		}
		out = append(out, params)
	}
	return out
}

// codexResetSequence reads the log as one line per step: each request an app-server heard, each command
// the control plane delivered, and what became of each result. Spawns and marks are left out.
func codexResetSequence(events []codexResetEvent) []string {
	var out []string
	for _, event := range events {
		switch {
		case event.Src == "app" && event.Method != "":
			out = append(out, "app "+event.Method)
		case event.Src == "cp" && event.Delivered != "":
			out = append(out, fmt.Sprintf("deliver %s/%d", event.Delivered, event.Generation))
		case event.Src == "cp" && event.Kind != "":
			step := event.Kind
			if event.Detail != "" {
				step += "/" + event.Detail
			}
			out = append(out, step+" -> "+event.Receipt)
		}
	}
	return out
}

// codexResetAfter is the part of the log after the test's mark.
func codexResetAfter(events []codexResetEvent, mark string) []codexResetEvent {
	for i, event := range events {
		if event.Src == "test" && event.Mark == mark {
			return events[i+1:]
		}
	}
	return nil
}

// codexResetSteps flattens steps and runs of steps into one expected sequence.
func codexResetSteps(parts ...interface{}) []string {
	var out []string
	for _, part := range parts {
		switch step := part.(type) {
		case string:
			out = append(out, step)
		case []string:
			out = append(out, step...)
		}
	}
	return out
}

func codexResetRequireSequence(t *testing.T, events []codexResetEvent, want []string) {
	t.Helper()
	if got := codexResetSequence(events); !reflect.DeepEqual(got, want) {
		t.Fatalf("the step went:\n  %s\nwant:\n  %s", strings.Join(got, "\n  "), strings.Join(want, "\n  "))
	}
}

// codexResetTestProcess is one runner process on the harness machine: its own leaseOwner, relay, usage
// probe and consume. crash ends it as a killed process ends: nothing it holds in memory reaches its
// successor.
type codexResetTestProcess struct {
	h      *codexResetHarness
	relay  *codexResetRelay
	probe  *planUsageProbe
	ops    *sync.WaitGroup
	cancel context.CancelFunc
}

func (h *codexResetHarness) process(tune ...func(*codexResetConsumer)) *codexResetTestProcess {
	ctx, cancel := context.WithCancel(context.Background())
	transport := NewTransport(h.server.URL, "runner-token")
	probe := newCodexPlanUsageProbe(transport.leaseOwner)
	consumer := newCodexResetConsumer(probe)
	consumer.now, consumer.wait = h.clock.now, h.clock.wait
	for _, change := range tune {
		change(consumer)
	}
	var ops sync.WaitGroup
	relay := newCodexResetRelay(ctx, transport, consumer.execute, &ops)
	relay.now, relay.wait = h.clock.now, h.clock.wait
	p := &codexResetTestProcess{h: h, relay: relay, probe: probe, ops: &ops, cancel: cancel}
	h.t.Cleanup(p.crash)
	return p
}

// heartbeat is one heartbeat of this process: the command the control plane hands it, if any, passed to
// its relay as runloop.go passes it.
func (p *codexResetTestProcess) heartbeat() *CodexRateLimitResetCommand {
	cmd := p.h.cp.dispatch(p.relay.leaseOwner)
	p.relay.handle(cmd, p.h.clock.now(), false)
	return cmd
}

func (p *codexResetTestProcess) finish() { p.ops.Wait() }

func (p *codexResetTestProcess) crash() {
	p.cancel()
	p.ops.Wait()
}

// ---------------------------------------------------------------------------
// the tests
// ---------------------------------------------------------------------------

// §6.4 on one process: the handshake; the read that has to name the operation's account; the consume
// under the persisted key and nothing else; the outcome reported and CONFIRMED; and only then a read of
// its own, reported as the refresh and kept for the next heartbeat. The key goes nowhere but the consume
// params: not into a result, a log line or the heartbeat.
func TestCodexResetConsumeCallsTheProviderInOrderUnderThePersistedKey(t *testing.T) {
	h := newCodexResetHarness(t, codexResetSignedIn(2, true))
	key := h.cp.operation().ProviderIdempotencyKey
	p := h.process()
	// The usage probe has read the account once already, as it does on its own schedule; the step's reads
	// carry on in the same sequence.
	usage, err := p.probe.fetch(context.Background(), p.probe.client)
	if err != nil {
		t.Fatal(err)
	}
	p.probe.store(usage)
	var cmd *CodexRateLimitResetCommand
	logs := captureRunnerStdout(t, func() {
		cmd = p.heartbeat()
		p.finish()
	})
	if cmd == nil || cmd.Phase != codexResetPhaseConsume || cmd.ClaimGeneration != 1 || cmd.ProviderIdempotencyKey != key {
		t.Fatalf("the first heartbeat handed %+v, want the operation's first CONSUME claim with its key", cmd)
	}

	events := h.events()
	codexResetRequireSequence(t, events, codexResetSteps(
		codexResetReadRequests,
		"deliver CONSUME/1",
		codexResetReadRequests, "app "+codexRateLimitResetConsumeMethod,
		"CONSUME_OUTCOME/reset -> APPLIED REFRESHING REFRESH",
		codexResetReadRequests,
		"REFRESHED -> APPLIED SUCCEEDED STOP",
	))
	if calls := h.requireOnlyThePersistedKey(events); calls != 1 {
		t.Fatalf("%d consume calls, want 1", calls)
	}
	for _, event := range events {
		switch event.Method {
		case codexAccountReadMethod:
			codexResetSameJSON(t, "account/read params", event.Params, []byte(`{"refreshToken":false}`))
		case codexRateLimitsReadMethod:
			if string(event.Params) != "null" {
				t.Fatalf("account/rateLimits/read params %s, want null", event.Params)
			}
		}
	}

	provider := h.provider(nil)
	if !reflect.DeepEqual(provider.Answers, []string{"reset"}) || !reflect.DeepEqual(provider.Redeemed, []string{key}) || provider.AvailableCount != 1 {
		t.Fatalf("the provider answered %v, redeemed %v and holds %d credits; want one reset under the key, leaving 1",
			provider.Answers, provider.Redeemed, provider.AvailableCount)
	}
	op := h.cp.operation()
	if op.status() != "SUCCEEDED" || op.ConsumeOutcome != "reset" || op.ProviderIdempotencyKey != key {
		t.Fatalf("the operation ended %+v, want SUCCEEDED on reset under its own key", op)
	}
	results := h.results(events)
	if results[0].ObservedAccountFingerprint != op.AccountFingerprint {
		t.Fatalf("the outcome observed account %q, want the operation's %q", results[0].ObservedAccountFingerprint, op.AccountFingerprint)
	}
	block := results[1].RateLimitReset
	if block.Generation != p.relay.leaseOwner || block.AccountFingerprint != op.AccountFingerprint || block.Sequence != 3 ||
		block.RateLimitResetCredits == nil || block.RateLimitResetCredits.AvailableCount != 1 {
		t.Fatalf("the refresh reported %+v, want this process's third read of the account (the probe's, the consume's, the refresh), counting the 1 credit left", block)
	}
	cached := p.probe.snapshot()
	if cached == nil || !reflect.DeepEqual(cached.RateLimitReset, block) {
		t.Fatalf("the probe cache holds %+v, want the refreshed block for the next heartbeat", cached)
	}

	heartbeat, err := json.Marshal(HeartbeatRequest{Status: "ONLINE", LeaseOwner: p.relay.leaseOwner, PlanUsage: combinePlanUsage(nil, cached)})
	if err != nil {
		t.Fatal(err)
	}
	sent := [][]byte{heartbeat, []byte(logs)}
	for _, event := range events {
		sent = append(sent, event.Result)
	}
	for _, secret := range []string{key, codexResetTestAccountID, codexResetTestEmail} {
		for _, text := range sent {
			if bytes.Contains(text, []byte(secret)) {
				t.Fatalf("%q reached a result, a log line or the heartbeat:\n%s", secret, text)
			}
		}
	}
}

// §1.2 and §7.3: each provider outcome becomes the status the contract derives from it. reset and
// alreadyRedeemed are CONFIRMED and followed by an authoritative read that carries the provider's count;
// nothingToReset and noCredit are CONFIRMED with no refresh at all. No outcome is asked for twice.
func TestCodexResetConsumeMapsEachOutcomeToItsOperationStatus(t *testing.T) {
	for _, tc := range []struct {
		outcome         string
		prepare         func(state *codexResetProviderState, key string)
		status, refresh string
		spent           int64
	}{
		{outcome: "reset", status: "SUCCEEDED", refresh: "SUCCEEDED", spent: 1},
		{
			outcome: "alreadyRedeemed", status: "SUCCEEDED", refresh: "SUCCEEDED",
			prepare: func(s *codexResetProviderState, key string) { s.Redeemed = []string{key} },
		},
		{
			outcome: "nothingToReset", status: "NOTHING_TO_RESET", refresh: "NOT_REQUIRED",
			prepare: func(s *codexResetProviderState, _ string) { s.Resettable = false },
		},
		{
			outcome: "noCredit", status: "NO_CREDIT", refresh: "NOT_REQUIRED",
			prepare: func(s *codexResetProviderState, _ string) { s.AvailableCount = 0 },
		},
	} {
		t.Run(tc.outcome, func(t *testing.T) {
			h := newCodexResetHarness(t, codexResetSignedIn(2, true))
			key := h.cp.operation().ProviderIdempotencyKey
			before := h.provider(func(s *codexResetProviderState) {
				if tc.prepare != nil {
					tc.prepare(s, key)
				}
			})
			p := h.process()
			p.heartbeat()
			p.finish()

			events := h.events()
			want := codexResetSteps("deliver CONSUME/1", codexResetReadRequests, "app "+codexRateLimitResetConsumeMethod)
			refreshes := codexRateLimitResetOutcomeEffects[tc.outcome].RefreshRequired
			if refreshes {
				want = codexResetSteps(want, "CONSUME_OUTCOME/"+tc.outcome+" -> APPLIED REFRESHING REFRESH",
					codexResetReadRequests, "REFRESHED -> APPLIED SUCCEEDED STOP")
			} else {
				want = codexResetSteps(want, "CONSUME_OUTCOME/"+tc.outcome+" -> APPLIED "+tc.status+" STOP")
			}
			codexResetRequireSequence(t, events, want)
			if calls := h.requireOnlyThePersistedKey(events); calls != 1 {
				t.Fatalf("%d consume calls, want 1", calls)
			}
			after := h.provider(nil)
			if !reflect.DeepEqual(after.Answers, []string{tc.outcome}) || before.AvailableCount-after.AvailableCount != tc.spent {
				t.Fatalf("the provider answered %v and spent %d credits, want %s spending %d",
					after.Answers, before.AvailableCount-after.AvailableCount, tc.outcome, tc.spent)
			}
			op := h.cp.operation()
			if op.ConsumeState != "CONFIRMED" || op.ConsumeOutcome != tc.outcome || op.RefreshState != tc.refresh || op.status() != tc.status {
				t.Fatalf("the operation ended %+v (%s), want CONFIRMED %s, refresh %s, status %s", op, op.status(), tc.outcome, tc.refresh, tc.status)
			}
			if refreshes {
				if counted := h.results(events)[1].RateLimitReset.RateLimitResetCredits; counted == nil || counted.AvailableCount != after.AvailableCount {
					t.Fatalf("the refresh counted %+v, want the provider's %d", counted, after.AvailableCount)
				}
			}
		})
	}
}

// §3, §4 and §6.4 step 3: before a consume is called, the command has to be this process's claim and a
// fresh read has to name the operation's account. Another process's claim, another account, a login
// that is not ChatGPT, a CLI without reset credits and custom API credentials in the runner's environment
// each end without a single consume call, with the code the contract gives them, and a read that names no
// account is asked again. Each has its paired positive: the operation's own account consumed once.
func TestCodexResetConsumeCallsNothingForAnAccountItCannotVouchFor(t *testing.T) {
	other, own := codexResetTestOtherAccount, codexResetTestAccountID
	for _, tc := range []struct {
		name     string
		change   func(*codexResetProviderState)
		env      string // a variable set in the runner's own environment
		result   string
		status   string
		observed string // the account the result reports observing
		spawned  bool
	}{
		{name: "the operation's own account", result: "CONSUME_OUTCOME/reset", status: "SUCCEEDED", observed: own, spawned: true},
		{
			name: "another account is signed in", change: func(s *codexResetProviderState) { s.AccountID = &other },
			result: "CONSUME_NOT_CALLED/ACCOUNT_MISMATCH", status: "NOT_ATTEMPTED", observed: other, spawned: true,
		},
		{
			name: "an API key login", change: func(s *codexResetProviderState) { s.Account = map[string]interface{}{"type": "apiKey"} },
			result: "CONSUME_NOT_CALLED/UNSUPPORTED_AUTH", status: "NOT_ATTEMPTED", spawned: true,
		},
		{
			name: "signed out", change: func(s *codexResetProviderState) { s.Account = nil },
			result: "CONSUME_NOT_CALLED/UNSUPPORTED_AUTH", status: "NOT_ATTEMPTED", spawned: true,
		},
		{
			name: "a CLI without reset credits", change: func(s *codexResetProviderState) { s.NoResetCredits = true },
			result: "CONSUME_NOT_CALLED/PROVIDER_UNSUPPORTED", status: "NOT_ATTEMPTED", spawned: true,
		},
		{
			name: "custom API credentials in the runner's environment", env: "OPENAI_API_KEY",
			result: "CONSUME_NOT_CALLED/UNSUPPORTED_AUTH", status: "NOT_ATTEMPTED",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newCodexResetHarness(t, codexResetSignedIn(2, true))
			h.provider(tc.change)
			secret := "orbit-test-secret-runner-environment"
			if tc.env != "" {
				t.Setenv(tc.env, secret)
			}
			p := h.process()
			logs := captureRunnerStdout(t, func() {
				p.heartbeat()
				p.finish()
			})
			events := h.events()
			calls := h.requireOnlyThePersistedKey(events)
			results := h.results(events)
			if len(results) == 0 {
				t.Fatal("the step reported nothing")
			}
			first := results[0]
			if got := first.Kind + "/" + first.Outcome + first.Code; got != tc.result {
				t.Fatalf("the step reported %s, want %s", got, tc.result)
			}
			if wantCalls := map[bool]int{true: 1, false: 0}[tc.status == "SUCCEEDED"]; calls != wantCalls {
				t.Fatalf("%d consume calls, want %d", calls, wantCalls)
			}
			observed := ""
			if tc.observed != "" {
				observed = codexAccountFingerprint(h.key, tc.observed)
			}
			if first.ObservedAccountFingerprint != observed {
				t.Fatalf("the result observed %q, want %q", first.ObservedAccountFingerprint, observed)
			}
			spawned := false
			for _, event := range events {
				spawned = spawned || event.Spawn
			}
			if spawned != tc.spawned {
				t.Fatalf("an app-server started: %v, want %v", spawned, tc.spawned)
			}
			if status := h.cp.operation().status(); status != tc.status {
				t.Fatalf("the operation ended %s, want %s", status, tc.status)
			}
			sent := [][]byte{[]byte(logs)}
			for _, event := range events {
				sent = append(sent, event.Result)
			}
			for _, text := range sent {
				if bytes.Contains(text, []byte(secret)) {
					t.Fatalf("the runner environment's value reached %s", text)
				}
			}
		})
	}

	t.Run("a read that names no account is asked again", func(t *testing.T) {
		h := newCodexResetHarness(t, codexResetSignedIn(2, true))
		h.provider(func(s *codexResetProviderState) { s.AccountID = nil })
		retrying := h.cp.stopAt("CONSUME_RETRYING", true)
		p := h.process()
		p.heartbeat()
		retrying.await(t)
		if calls := h.requireOnlyThePersistedKey(h.events()); calls != 0 {
			t.Fatalf("a read that names no account was followed by %d consume calls", calls)
		}
		h.provider(func(s *codexResetProviderState) { s.AccountID = &own })
		close(retrying.release)
		p.finish()
		events := h.events()
		codexResetRequireSequence(t, events, codexResetSteps(
			"deliver CONSUME/1",
			codexResetReadRequests, "CONSUME_RETRYING/ACCOUNT_UNIDENTIFIED -> APPLIED CONSUMING RETRY_CONSUME (held)",
			codexResetReadRequests, "app "+codexRateLimitResetConsumeMethod, "CONSUME_OUTCOME/reset -> APPLIED REFRESHING REFRESH",
			codexResetReadRequests, "REFRESHED -> APPLIED SUCCEEDED STOP",
		))
		if calls := h.requireOnlyThePersistedKey(events); calls != 1 {
			t.Fatalf("%d consume calls, want 1", calls)
		}
	})

	t.Run("another process's claim", func(t *testing.T) {
		h := newCodexResetHarness(t, codexResetSignedIn(2, true))
		owner, bystander := h.process(), h.process()
		cmd := h.cp.dispatch(owner.relay.leaseOwner)
		bystander.relay.handle(cmd, h.clock.now(), false)
		bystander.finish()
		if events := h.events(); len(codexResetSequence(events)) != 1 || len(h.results(events)) != 0 {
			t.Fatalf("a process acted on another process's claim:\n%s", strings.Join(codexResetSequence(events), "\n"))
		}
		owner.relay.handle(cmd, h.clock.now(), false)
		owner.finish()
		if calls := h.requireOnlyThePersistedKey(h.events()); calls != 1 || h.cp.operation().status() != "SUCCEEDED" {
			t.Fatalf("the claim's own process made %d consume calls and left %s; want 1 and SUCCEEDED", calls, h.cp.operation().status())
		}
	})
}

// §1.2 and §6.4 step 5: whatever keeps a consume from an outcome — an app-server that dies in its
// handshake, a failed read, the provider's error, an answer that is no outcome, no answer in time, or an
// app-server that dies after the provider spent the credit — is reported with its own retryable code and
// asked again after a backoff, under the same key. The provider spends one credit, and the operation
// records the one outcome that key has.
func TestCodexResetConsumeRetriesWithoutAnOutcomeUnderTheSameKey(t *testing.T) {
	h := newCodexResetHarness(t, codexResetSignedIn(2, true))
	key := h.cp.operation().ProviderIdempotencyKey
	consume := codexRateLimitResetConsumeMethod
	h.provider(func(s *codexResetProviderState) {
		s.Faults = []codexResetProviderFault{
			{Method: "initialize", Do: "exit"},
			{Method: codexRateLimitsReadMethod, Do: "error"},
			{Method: consume, Do: "error"},
			{Method: consume, Do: "garbage"},
			{Method: consume, Do: "hang"},
			{Method: consume, Do: "spendThenExit"},
		}
	})
	p := h.process(func(c *codexResetConsumer) { c.consumeTimeout = 3 * time.Second })
	p.heartbeat()
	p.finish()

	events := h.events()
	retry := func(code string) string { return "CONSUME_RETRYING/" + code + " -> APPLIED CONSUMING RETRY_CONSUME" }
	codexResetRequireSequence(t, events, codexResetSteps(
		"deliver CONSUME/1",
		"app initialize", retry("APP_SERVER_UNAVAILABLE"),
		codexResetReadRequests, retry("READ_FAILED"),
		codexResetReadRequests, "app "+consume, retry("PROVIDER_ERROR"),
		codexResetReadRequests, "app "+consume, retry("PROVIDER_ERROR"),
		codexResetReadRequests, "app "+consume, retry("PROVIDER_TIMEOUT"),
		codexResetReadRequests, "app "+consume, retry("APP_SERVER_UNAVAILABLE"),
		codexResetReadRequests, "app "+consume, "CONSUME_OUTCOME/alreadyRedeemed -> APPLIED REFRESHING REFRESH",
		codexResetReadRequests, "REFRESHED -> APPLIED SUCCEEDED STOP",
	))
	if calls := h.requireOnlyThePersistedKey(events); calls != 5 {
		t.Fatalf("%d consume calls, want 5", calls)
	}
	provider := h.provider(nil)
	if !reflect.DeepEqual(provider.Answers, []string{"reset", "alreadyRedeemed"}) || !reflect.DeepEqual(provider.Redeemed, []string{key}) || provider.AvailableCount != 1 {
		t.Fatalf("the provider answered %v, redeemed %v and holds %d; want one credit spent under the one key",
			provider.Answers, provider.Redeemed, provider.AvailableCount)
	}
	if op := h.cp.operation(); op.status() != "SUCCEEDED" || op.ConsumeOutcome != "alreadyRedeemed" || op.LastErrorCode != "" {
		t.Fatalf("the operation ended %+v", op)
	}
	backoff := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 30 * time.Second}
	if !reflect.DeepEqual(h.clock.waited, backoff) {
		t.Fatalf("backed off %v, want %v", h.clock.waited, backoff)
	}
}

// §6.4 and §7.2: the refresh starts only once the outcome's receipt says it is CONFIRMED, and from then on
// nothing the refresh or a receipt comes to calls consume again. A lost receipt is sent again byte for
// byte; a refused result ends the step; a failed read is read again; another account fails the refresh
// for good while the consume stays confirmed; and a REFRESH command only reads.
func TestCodexResetRefreshFollowsOnlyAConfirmedConsume(t *testing.T) {
	consume := "app " + codexRateLimitResetConsumeMethod

	t.Run("a lost receipt is sent again before the refresh starts", func(t *testing.T) {
		h := newCodexResetHarness(t, codexResetSignedIn(2, true))
		h.cp.loseReceipts("CONSUME_OUTCOME", 2)
		p := h.process()
		p.heartbeat()
		p.finish()
		events := h.events()
		codexResetRequireSequence(t, events, codexResetSteps(
			"deliver CONSUME/1", codexResetReadRequests, consume,
			"CONSUME_OUTCOME/reset -> APPLIED REFRESHING REFRESH (receipt lost)",
			"CONSUME_OUTCOME/reset -> DUPLICATE REFRESHING REFRESH (receipt lost)",
			"CONSUME_OUTCOME/reset -> DUPLICATE REFRESHING REFRESH",
			codexResetReadRequests, "REFRESHED -> APPLIED SUCCEEDED STOP",
		))
		if calls := h.requireOnlyThePersistedKey(events); calls != 1 {
			t.Fatalf("%d consume calls, want 1", calls)
		}
		var sent [][]byte
		for _, event := range events {
			if event.Kind == "CONSUME_OUTCOME" {
				sent = append(sent, event.Result)
			}
		}
		if len(sent) != 3 || !bytes.Equal(sent[0], sent[1]) || !bytes.Equal(sent[0], sent[2]) {
			t.Fatalf("the outcome was sent as %q, want the same bytes three times", sent)
		}
	})

	t.Run("a result refused as a stale claim ends the step", func(t *testing.T) {
		h := newCodexResetHarness(t, codexResetSignedIn(2, true))
		held := h.cp.stopAt("CONSUME_OUTCOME", false)
		slow := h.process()
		first := slow.heartbeat()
		held.await(t)
		h.clock.advance(h.cp.takeover + time.Second)
		successor := h.process()
		taken := h.cp.dispatch(successor.relay.leaseOwner)
		close(held.release)
		slow.finish()
		// The slow process's own claim, delivered again, starts nothing: its consume already ran here.
		slow.relay.handle(first, h.clock.now(), false)
		slow.finish()
		successor.relay.handle(taken, h.clock.now(), false)
		successor.finish()

		events := h.events()
		codexResetRequireSequence(t, events, codexResetSteps(
			"deliver CONSUME/1", codexResetReadRequests, consume,
			"CONSUME_OUTCOME/reset -> held before applying",
			"deliver CONSUME/2",
			"CONSUME_OUTCOME/reset -> refused STALE_CLAIM",
			codexResetReadRequests, consume, "CONSUME_OUTCOME/alreadyRedeemed -> APPLIED REFRESHING REFRESH",
			codexResetReadRequests, "REFRESHED -> APPLIED SUCCEEDED STOP",
		))
		if calls := h.requireOnlyThePersistedKey(events); calls != 2 {
			t.Fatalf("%d consume calls, want the slow claim's and its successor's", calls)
		}
		if provider := h.provider(nil); !reflect.DeepEqual(provider.Answers, []string{"reset", "alreadyRedeemed"}) || provider.AvailableCount != 1 {
			t.Fatalf("the provider answered %v and holds %d, want one credit spent", provider.Answers, provider.AvailableCount)
		}
	})

	t.Run("a failed refresh is read again without touching the consume", func(t *testing.T) {
		h := newCodexResetHarness(t, codexResetSignedIn(2, true))
		h.provider(func(s *codexResetProviderState) {
			s.Faults = []codexResetProviderFault{
				{Method: "initialize", Skip: 1, Do: "exit"},
				{Method: codexRateLimitsReadMethod, Skip: 1, Do: "error"},
			}
		})
		p := h.process()
		p.heartbeat()
		p.finish()
		events := h.events()
		codexResetRequireSequence(t, events, codexResetSteps(
			"deliver CONSUME/1", codexResetReadRequests, consume,
			"CONSUME_OUTCOME/reset -> APPLIED REFRESHING REFRESH",
			"app initialize", "REFRESH_FAILED/APP_SERVER_UNAVAILABLE -> APPLIED REFRESHING RETRY_REFRESH",
			codexResetReadRequests, "REFRESH_FAILED/READ_FAILED -> APPLIED REFRESHING RETRY_REFRESH",
			codexResetReadRequests, "REFRESHED -> APPLIED SUCCEEDED STOP",
		))
		if calls := h.requireOnlyThePersistedKey(events); calls != 1 {
			t.Fatalf("%d consume calls, want 1", calls)
		}
		if op := h.cp.operation(); op.ConsumeState != "CONFIRMED" || op.ConsumeOutcome != "reset" || op.status() != "SUCCEEDED" {
			t.Fatalf("the operation ended %+v", op)
		}
		if want := []time.Duration{time.Second, 2 * time.Second}; !reflect.DeepEqual(h.clock.waited, want) {
			t.Fatalf("backed off %v, want %v", h.clock.waited, want)
		}
	})

	t.Run("another account after the consume fails the refresh for good", func(t *testing.T) {
		h := newCodexResetHarness(t, codexResetSignedIn(2, true))
		confirmed := h.cp.stopAt("CONSUME_OUTCOME", true)
		p := h.process()
		p.heartbeat()
		confirmed.await(t)
		other := codexResetTestOtherAccount
		h.provider(func(s *codexResetProviderState) { s.AccountID = &other })
		close(confirmed.release)
		p.finish()
		events := h.events()
		codexResetRequireSequence(t, events, codexResetSteps(
			"deliver CONSUME/1", codexResetReadRequests, consume,
			"CONSUME_OUTCOME/reset -> APPLIED REFRESHING REFRESH (held)",
			codexResetReadRequests, "REFRESH_FAILED/ACCOUNT_MISMATCH -> APPLIED REFRESH_FAILED STOP",
		))
		if calls := h.requireOnlyThePersistedKey(events); calls != 1 {
			t.Fatalf("%d consume calls, want 1", calls)
		}
		op := h.cp.operation()
		if op.ConsumeState != "CONFIRMED" || op.ConsumeOutcome != "reset" || op.RefreshState != "FAILED" || op.FailureCode != "ACCOUNT_MISMATCH" {
			t.Fatalf("the operation ended %+v, want the consume still CONFIRMED and the refresh FAILED", op)
		}
		if observed := h.results(events)[1].ObservedAccountFingerprint; observed != codexAccountFingerprint(h.key, other) {
			t.Fatalf("the refresh observed %q, want the other account's fingerprint", observed)
		}
	})

	t.Run("a REFRESH command only reads", func(t *testing.T) {
		h := newCodexResetHarness(t, codexResetSignedIn(1, false))
		h.cp.edit(func(op *codexResetModelOperation) {
			op.ConsumeState, op.ConsumeOutcome, op.RefreshState = "CONFIRMED", "reset", "PENDING"
		})
		p := h.process()
		cmd := p.heartbeat()
		p.finish()
		if cmd == nil || cmd.Phase != codexResetPhaseRefresh || cmd.ProviderIdempotencyKey != "" {
			t.Fatalf("the heartbeat handed %+v, want a keyless REFRESH", cmd)
		}
		events := h.events()
		codexResetRequireSequence(t, events, codexResetSteps(
			"deliver REFRESH/1", codexResetReadRequests, "REFRESHED -> APPLIED SUCCEEDED STOP",
		))
		if calls := h.requireOnlyThePersistedKey(events); calls != 0 {
			t.Fatalf("%d consume calls, want none", calls)
		}
	})
}

// §6.4 and §6.5: a runner process killed at any point of a step — the credit spent but unanswered, the
// outcome answered but never reported, reported but its receipt unread, the refresh in flight, read but
// unreported, reported but its receipt unread, or after all of it — leaves its successor exactly what the
// control plane recorded. The successor's claim goes on under the same key: a CONSUME only while no
// outcome was recorded, which the provider answers for that key without spending a second credit, and
// otherwise a REFRESH or nothing.
func TestCodexResetConsumeRecoversFromACrashAtEveryCheckpoint(t *testing.T) {
	consume := codexRateLimitResetConsumeMethod
	stopAt := func(kind string, applied bool) func(h *codexResetHarness) func() {
		return func(h *codexResetHarness) func() {
			stop := h.cp.stopAt(kind, applied)
			return func() { stop.await(h.t) }
		}
	}
	successorConsumes := func(outcome string) []string {
		return codexResetSteps("deliver CONSUME/2", codexResetReadRequests, "app "+consume,
			"CONSUME_OUTCOME/"+outcome+" -> APPLIED REFRESHING REFRESH", codexResetReadRequests, "REFRESHED -> APPLIED SUCCEEDED STOP")
	}
	successorRefreshes := codexResetSteps("deliver REFRESH/2", codexResetReadRequests, "REFRESHED -> APPLIED SUCCEEDED STOP")

	for _, tc := range []struct {
		name string
		// arrange sets the checkpoint up before the first process runs, and returns the wait for it to
		// get there; nil lets the first process finish.
		arrange func(h *codexResetHarness) func()
		// between changes the provider while no process runs.
		between   func(h *codexResetHarness)
		successor []string
		answers   []string
	}{
		{
			name: "the provider spent the credit and its answer never reached the runner",
			arrange: func(h *codexResetHarness) func() {
				h.provider(func(s *codexResetProviderState) {
					s.Faults = []codexResetProviderFault{{Method: consume, Do: "spendThenHang"}}
				})
				return func() {
					h.waitFor("the consume the provider spent and never answered", func(e codexResetEvent) bool {
						return e.Method == consume && e.Answer == "spendThenHang"
					})
				}
			},
			successor: successorConsumes("alreadyRedeemed"),
			answers:   []string{"reset", "alreadyRedeemed"},
		},
		{
			name:      "the outcome was answered and never reached the control plane",
			arrange:   stopAt("CONSUME_OUTCOME", false),
			successor: successorConsumes("alreadyRedeemed"),
			answers:   []string{"reset", "alreadyRedeemed"},
		},
		{
			name:      "the control plane confirmed the outcome and its receipt was never read",
			arrange:   stopAt("CONSUME_OUTCOME", true),
			successor: successorRefreshes,
			answers:   []string{"reset"},
		},
		{
			name: "the receipt was read and the authoritative read was in flight",
			arrange: func(h *codexResetHarness) func() {
				h.provider(func(s *codexResetProviderState) {
					s.Faults = []codexResetProviderFault{{Method: codexRateLimitsReadMethod, Skip: 1, Do: "hang"}}
				})
				return func() {
					h.waitFor("the refresh read in flight", func(e codexResetEvent) bool {
						return e.Method == codexRateLimitsReadMethod && e.Answer == "hang"
					})
				}
			},
			successor: successorRefreshes,
			answers:   []string{"reset"},
		},
		{
			name:      "the refresh was read and never reached the control plane",
			arrange:   stopAt("REFRESHED", false),
			successor: successorRefreshes,
			answers:   []string{"reset"},
		},
		{
			name:    "the control plane recorded the refresh and its receipt was never read",
			arrange: stopAt("REFRESHED", true),
			answers: []string{"reset"},
		},
		{
			name:    "the step had finished",
			answers: []string{"reset"},
		},
		{
			name: "an unrecorded nothingToReset is asked again under the same key",
			arrange: func(h *codexResetHarness) func() {
				h.provider(func(s *codexResetProviderState) { s.Resettable = false })
				return stopAt("CONSUME_OUTCOME", false)(h)
			},
			between:   func(h *codexResetHarness) { h.provider(func(s *codexResetProviderState) { s.Resettable = true }) },
			successor: successorConsumes("reset"),
			answers:   []string{"nothingToReset", "reset"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newCodexResetHarness(t, codexResetSignedIn(2, true))
			key := h.cp.operation().ProviderIdempotencyKey
			var reached func()
			if tc.arrange != nil {
				reached = tc.arrange(h)
			}
			first := h.process()
			if cmd := first.heartbeat(); cmd == nil || cmd.Phase != codexResetPhaseConsume || cmd.ClaimGeneration != 1 {
				t.Fatalf("the first process was handed %+v, want the first CONSUME claim", cmd)
			}
			if reached != nil {
				reached()
			} else {
				first.finish()
			}
			first.crash()
			h.mark("crashed")
			if tc.between != nil {
				tc.between(h)
			}

			h.clock.advance(h.cp.takeover + time.Second)
			successor := h.process()
			cmd := successor.heartbeat()
			successor.finish()
			if cmd != nil && cmd.Phase == codexResetPhaseConsume && cmd.ProviderIdempotencyKey != key {
				t.Fatalf("the successor was handed a consume under %q, want the operation's key", cmd.ProviderIdempotencyKey)
			}

			events := h.events()
			h.requireOnlyThePersistedKey(events)
			codexResetRequireSequence(t, codexResetAfter(events, "crashed"), tc.successor)
			provider := h.provider(nil)
			if !reflect.DeepEqual(provider.Answers, tc.answers) || !reflect.DeepEqual(provider.Redeemed, []string{key}) || provider.AvailableCount != 1 {
				t.Fatalf("the provider answered %v, redeemed %v and holds %d; want %v, exactly one credit spent under the one key",
					provider.Answers, provider.Redeemed, provider.AvailableCount, tc.answers)
			}
			if op := h.cp.operation(); op.status() != "SUCCEEDED" || op.ProviderIdempotencyKey != key {
				t.Fatalf("the operation ended %+v (%s), want SUCCEEDED under its own key", op, op.status())
			}
		})
	}
}

// §4: declaring the capability promises that a claimed command is carried out. The header every request
// carries declares it, and the relay runloop.go builds hands its commands to the consume — declared
// without one, a process would be claimed operations it settles nothing of.
func TestCodexResetCapabilityIsDeclaredWithTheConsumeThatServesIt(t *testing.T) {
	declared := false
	for _, token := range strings.Split(runnerCapabilitiesV1, ",") {
		declared = declared || token == codexRateLimitResetCapabilityV1
	}
	if !declared {
		t.Fatalf("the runner does not declare %q: %q", codexRateLimitResetCapabilityV1, runnerCapabilitiesV1)
	}
	runloop, err := os.ReadFile("runloop.go")
	if err != nil {
		t.Fatal(err)
	}
	if wiring := "newCodexResetRelay(resetCtx, t, newCodexResetConsumer(codexUsageProbe).execute, &heartbeatOps)"; !strings.Contains(string(runloop), wiring) {
		t.Fatalf("runloop.go no longer builds its reset relay as %s", wiring)
	}
}
