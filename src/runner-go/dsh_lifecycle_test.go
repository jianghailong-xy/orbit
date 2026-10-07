//go:build !windows

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// P3b lifecycle scenarios. Each one runs the production session loop against a synthetic
// dsh (this test binary) that persists its sessions in the real DSH_HOME P2 prepares, and a
// fake control plane that keeps Orbit's turn rows the way the inbox SQL does. Assertions
// compare that "database" with the engine's own session log, request record and side-effect
// file, never only an exit status.

const lcSessionID = "lc-orbit-session"

type lcTurn struct {
	ID, Kind, Content string
	Env               map[string]string
	TaskAcceptance    bool
	Status            string // PENDING, IN_FLIGHT, DELIVERED (control kinds) or the settled status
	Deliveries        int
	expired           bool
	Completions       []TurnCompleteRequest
}

// lcControlPlane mirrors runner-api's dequeueTurn: control kinds jump the queue, and a
// message is leased only while no other message is IN_FLIGHT, unless its lease expired.
type lcControlPlane struct {
	mu           sync.Mutex
	turns        []*lcTurn
	leaseLost    bool
	busyDelivery bool
	drop         map[string]bool // completions that never reach the database
	violations   []string
	changed      chan struct{}
	srv          *httptest.Server
}

func newLCControlPlane(t *testing.T) *lcControlPlane {
	cp := &lcControlPlane{changed: make(chan struct{}, 1)}
	cp.srv = httptest.NewServer(http.HandlerFunc(cp.serve))
	t.Cleanup(cp.srv.Close)
	return cp
}

func (cp *lcControlPlane) notify() {
	select {
	case cp.changed <- struct{}{}:
	default:
	}
}

func (cp *lcControlPlane) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	switch {
	case strings.HasSuffix(r.URL.Path, "/inbox"):
		deadline := time.Now().Add(150 * time.Millisecond)
		for {
			resp, status := cp.next()
			if status != 0 {
				http.Error(w, "inbox lease generation is no longer current", status)
				return
			}
			if resp != nil {
				_ = json.NewEncoder(w).Encode(resp)
				return
			}
			if time.Now().After(deadline) {
				_ = json.NewEncoder(w).Encode(RunInboxResponse{})
				return
			}
			select {
			case <-cp.changed:
			case <-time.After(20 * time.Millisecond):
			case <-r.Context().Done():
				return
			}
		}
	case strings.HasSuffix(r.URL.Path, "/lc-turn-complete"):
		var req TurnCompleteRequest
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			http.Error(w, "bad completion", http.StatusBadRequest)
			return
		}
		_ = cp.complete(req)
		_, _ = w.Write([]byte(`{}`))
	case strings.HasSuffix(r.URL.Path, "/diff"):
		_, _ = w.Write([]byte(`{}`))
	default:
		http.NotFound(w, r)
	}
}

func lcExecutable(kind string) bool { return kind == "message" || kind == "shell" }

func (cp *lcControlPlane) next() (*RunInboxResponse, int) {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	if cp.leaseLost {
		return nil, http.StatusConflict
	}
	deliver := func(turn *lcTurn) *RunInboxResponse {
		turn.Deliveries++
		return &RunInboxResponse{TurnID: turn.ID, Kind: turn.Kind, Content: turn.Content, Env: turn.Env, TaskAcceptance: turn.TaskAcceptance}
	}
	for _, turn := range cp.turns {
		if !lcExecutable(turn.Kind) && turn.Status == "PENDING" {
			turn.Status = "DELIVERED"
			return deliver(turn), 0
		}
	}
	for _, turn := range cp.turns {
		if turn.expired {
			turn.expired = false
			return deliver(turn), 0
		}
	}
	busy := false
	for _, turn := range cp.turns {
		busy = busy || (lcExecutable(turn.Kind) && turn.Status == "IN_FLIGHT")
	}
	for _, turn := range cp.turns {
		if lcExecutable(turn.Kind) && turn.Status == "PENDING" && (!busy || cp.busyDelivery) {
			turn.Status = "IN_FLIGHT"
			return deliver(turn), 0
		}
	}
	return nil, 0
}

func (cp *lcControlPlane) add(id, kind, content string) {
	cp.addTurn(&lcTurn{ID: id, Kind: kind, Content: content})
}

func (cp *lcControlPlane) addTurn(turn *lcTurn) {
	cp.mu.Lock()
	turn.Status = "PENDING"
	cp.turns = append(cp.turns, turn)
	cp.mu.Unlock()
	cp.notify()
}

// redeliver hands a turn out again: an expired lease, or a stale long-poll answer.
func (cp *lcControlPlane) redeliver(id string) {
	cp.mu.Lock()
	for _, turn := range cp.turns {
		if turn.ID == id {
			turn.expired = true
		}
	}
	cp.mu.Unlock()
	cp.notify()
}

func (cp *lcControlPlane) setLeaseLost(lost bool) {
	cp.mu.Lock()
	cp.leaseLost = lost
	cp.mu.Unlock()
	cp.notify()
}

func (cp *lcControlPlane) complete(req TurnCompleteRequest, _ ...context.Context) error {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	defer cp.notify()
	if cp.drop[req.TurnID] {
		delete(cp.drop, req.TurnID)
		return errors.New("synthetic control plane unreachable")
	}
	for _, turn := range cp.turns {
		if turn.ID != req.TurnID {
			continue
		}
		turn.Completions = append(turn.Completions, req)
		if turn.Status != "IN_FLIGHT" {
			cp.violations = append(cp.violations, fmt.Sprintf("turn %s settled while %s", req.TurnID, turn.Status))
		}
		turn.Status = req.Status
		return nil
	}
	cp.violations = append(cp.violations, "completion for unknown turn "+req.TurnID)
	return nil
}

func (cp *lcControlPlane) turn(id string) lcTurn {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	for _, turn := range cp.turns {
		if turn.ID == id {
			copied := *turn
			copied.Completions = append([]TurnCompleteRequest(nil), turn.Completions...)
			return copied
		}
	}
	return lcTurn{}
}

func (cp *lcControlPlane) waitSettled(t *testing.T, id string) lcTurn {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		turn := cp.turn(id)
		if turn.Status != "" && turn.Status != "PENDING" && turn.Status != "IN_FLIGHT" {
			return turn
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("turn %s never settled: %+v", id, cp.turn(id))
	return lcTurn{}
}

func (cp *lcControlPlane) checkClean(t *testing.T) {
	t.Helper()
	cp.mu.Lock()
	defer cp.mu.Unlock()
	if len(cp.violations) > 0 {
		t.Fatalf("control-plane rows were settled twice or out of lease: %v", cp.violations)
	}
}

type lcHarness struct {
	t                                         *testing.T
	cp                                        *lcControlPlane
	dir, work, home, scratch, record, effects string
	key                                       string
	extraEnv                                  []string
	events                                    dshProcessEvents
	mu                                        sync.Mutex
	prepared                                  []string
	preparedDirs                              []string
}

func newLCHarness(t *testing.T) *lcHarness {
	t.Helper()
	dir := t.TempDir()
	h := &lcHarness{t: t, cp: newLCControlPlane(t), dir: dir, work: filepath.Join(dir, "work"), home: filepath.Join(dir, "dsh-home"),
		scratch: filepath.Join(dir, "scratch"), record: filepath.Join(dir, "engine-requests.ndjson"),
		effects: filepath.Join(dir, "side-effects.log"), key: "sk-p3b-synthetic-key-0001"}
	for _, path := range []string{h.work, h.scratch} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	previous := prepareDshSessionLaunch
	prepareDshSessionLaunch = h.prepare
	t.Cleanup(func() { prepareDshSessionLaunch = previous })
	return h
}

// prepare is P2's preparer minus the install step, so every scenario runs the production
// prepare -> initialize -> Seal -> new/resume path against the synthetic engine.
func (h *lcHarness) prepare(ctx context.Context, job *ClaimedSession, execDir string) (DshLaunchSpec, error) {
	key := job.Agent.Env["ORBIT_DSH_API_KEY"]
	h.mu.Lock()
	h.prepared = append(h.prepared, key)
	h.preparedDirs = append(h.preparedDirs, execDir)
	h.mu.Unlock()
	if strings.TrimSpace(key) == "" {
		return DshLaunchSpec{}, errors.New(dshMissingKeyMessage)
	}
	exe, err := os.Executable()
	if err != nil {
		return DshLaunchSpec{}, err
	}
	spec, err := prepareDshConfigAt(DshLaunchInput{OrbitSessionID: job.SessionID, ExecutionDir: execDir, APIKey: key,
		BaseURL: job.Agent.Env["ORBIT_DSH_BASE_URL"], FileMode: dshFileModeForPermission(job.Agent.PermissionMode)}, exe, h.home)
	if err != nil {
		return DshLaunchSpec{}, err
	}
	spec.Args = []string{"-test.run=^TestDshLifecycleHelperProcess$"}
	spec.Env = append(append(spec.Env, "DSH_LC_HELPER=1", "DSH_LC_RECORD="+h.record, "DSH_LC_EFFECTS="+h.effects,
		"DSH_LC_CHILD="+filepath.Join(h.dir, "child")), h.extraEnv...)
	return spec, nil
}

func (h *lcHarness) job() *ClaimedSession {
	return &ClaimedSession{SessionID: lcSessionID, Provider: providerDsh,
		Agent: AgentExecConfig{Provider: providerDsh, Env: map[string]string{"ORBIT_DSH_API_KEY": h.key}}}
}

type lcRun struct {
	done      chan struct{}
	status    string
	ended     bool
	reload    bool
	leaseLost atomic.Int32
	cancel    context.CancelFunc
	shutdown  context.CancelFunc
}

func (h *lcHarness) start(job *ClaimedSession) *lcRun {
	return h.startIn(job, h.work)
}

func (h *lcHarness) startIn(job *ClaimedSession, execDir string) *lcRun {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	shutdownCtx, shutdown := context.WithCancel(context.Background())
	run := &lcRun{done: make(chan struct{}), cancel: cancel, shutdown: shutdown}
	go func() {
		defer close(run.done)
		run.status, run.ended, run.reload = providerRuntimeFor(runtimeProvider(job)).run(sessionProcessArgs{
			ctx: ctx, shutdownCtx: shutdownCtx, t: NewTransport(h.cp.srv.URL, "synthetic-runner-token"), job: job,
			leaseGeneration: "lc-generation", execDir: execDir, scratchDir: h.scratch,
			emit:           func(typ string, payload map[string]interface{}) { h.events.emit("", typ, payload) },
			emitFor:        h.events.emit,
			setTurn:        func(string) {},
			completeTurn:   h.cp.complete,
			waitTurnPermit: func(context.Context) bool { return true },
			onLeaseLost:    func(error) { run.leaseLost.Add(1) },
		})
	}()
	h.t.Cleanup(func() {
		shutdown()
		cancel()
		select {
		case <-run.done:
		case <-time.After(20 * time.Second):
			h.t.Error("dsh session loop did not stop")
		}
	})
	return run
}

func (r *lcRun) wait(t *testing.T) {
	t.Helper()
	select {
	case <-r.done:
	case <-time.After(30 * time.Second):
		t.Fatal("dsh session loop did not return")
	}
}

type lcRecord struct {
	PID    int                    `json:"pid"`
	Msg    map[string]interface{} `json:"msg,omitempty"`
	Note   string                 `json:"note,omitempty"`
	Fields map[string]interface{} `json:"fields,omitempty"`
}

func (h *lcHarness) records() []lcRecord {
	h.t.Helper()
	data, err := os.ReadFile(h.record)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		h.t.Fatal(err)
	}
	var out []lcRecord
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if line == "" {
			continue
		}
		var rec lcRecord
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			h.t.Fatalf("engine record: %v", err)
		}
		out = append(out, rec)
	}
	return out
}

func (h *lcHarness) methods() []string {
	var methods []string
	for _, rec := range h.records() {
		if method, _ := rec.Msg["method"].(string); method != "" {
			methods = append(methods, method)
		}
	}
	return methods
}

func (h *lcHarness) count(method string) int {
	n := 0
	for _, m := range h.methods() {
		if m == method {
			n++
		}
	}
	return n
}

func (h *lcHarness) notes(kind string) []lcRecord {
	var out []lcRecord
	for _, rec := range h.records() {
		if rec.Note == kind {
			out = append(out, rec)
		}
	}
	return out
}

func (h *lcHarness) promptTexts() []string {
	var out []string
	for _, rec := range h.records() {
		if rec.Msg["method"] == "session/prompt" {
			blocks, _ := mapValue(rec.Msg["params"])["prompt"].([]interface{})
			if len(blocks) > 0 {
				out = append(out, firstString(mapValue(blocks[0]), "text"))
			}
		}
	}
	return out
}

func (h *lcHarness) effectLines() []string {
	data, err := os.ReadFile(h.effects)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		h.t.Fatal(err)
	}
	return strings.Fields(strings.TrimSpace(string(data)))
}

// The engine's own durable session log, as the synthetic dsh persisted it in DSH_HOME.
func (h *lcHarness) sessionLog(id string) lcEngineSession {
	h.t.Helper()
	var session lcEngineSession
	data, err := os.ReadFile(filepath.Join(h.home, "lc-sessions", id+".json"))
	if err != nil || json.Unmarshal(data, &session) != nil {
		h.t.Fatalf("engine session log %s: %v", id, err)
	}
	return session
}

func (h *lcHarness) ledger() *dshTurnLedger {
	h.t.Helper()
	ledger, err := loadDshTurnLedger(h.home)
	if err != nil {
		h.t.Fatal(err)
	}
	return ledger
}

func (h *lcHarness) turnEvents(turn string) []dshProcessEvent {
	var out []dshProcessEvent
	for _, event := range h.events.snapshot() {
		if event.turn == turn {
			out = append(out, event)
		}
	}
	return out
}

func lcCount(events []dshProcessEvent, typ string) int {
	n := 0
	for _, event := range events {
		if event.typ == typ {
			n++
		}
	}
	return n
}

// Each turn's transcript: one user event, one turn_end, every tool closed, in order.
func (h *lcHarness) checkTurnTranscript(turn string, wantUser bool) []dshProcessEvent {
	h.t.Helper()
	events := h.turnEvents(turn)
	if lcCount(events, evTurnEnd) != 1 {
		h.t.Fatalf("turn %s must end exactly once: %+v", turn, events)
	}
	if wantUser && lcCount(events, evUser) != 1 {
		h.t.Fatalf("turn %s user message count: %+v", turn, events)
	}
	open := map[string]bool{}
	for _, event := range events {
		switch event.typ {
		case evToolUse:
			open[fmt.Sprint(event.payload["id"])] = true
		case evToolResult:
			id := fmt.Sprint(event.payload["toolUseId"])
			if !open[id] && event.payload["recovered"] == nil && !strings.Contains(fmt.Sprint(event.payload["content"]), "stopped before") {
				h.t.Fatalf("turn %s closed tool %s it never opened: %+v", turn, id, events)
			}
			delete(open, id)
		}
		if event.payload["localTurnId"] != nil && event.payload["localTurnId"] != turn {
			h.t.Fatalf("event attributed to another turn: %+v", event)
		}
	}
	if len(open) > 0 {
		h.t.Fatalf("turn %s left tools without a terminal status: %v", turn, open)
	}
	return events
}

// recordEvidence writes the scenario's control-plane rows, engine session logs, request
// sequence and side effects for the acceptance script to keep.
func (h *lcHarness) recordEvidence(name string) {
	dir := os.Getenv("DSH_P3B_EVIDENCE_DIR")
	if dir == "" {
		return
	}
	h.cp.mu.Lock()
	var rows []map[string]interface{}
	for _, turn := range h.cp.turns {
		var completions []map[string]interface{}
		for _, c := range turn.Completions {
			completions = append(completions, map[string]interface{}{"status": c.Status, "subtype": c.Subtype,
				"result": c.Result, "error": c.Error, "runtimeSessionId": c.RuntimeSessionID})
		}
		rows = append(rows, map[string]interface{}{"turnId": turn.ID, "kind": turn.Kind, "status": turn.Status,
			"deliveries": turn.Deliveries, "completions": completions})
	}
	h.cp.mu.Unlock()
	sessions := map[string]interface{}{}
	files, _ := filepath.Glob(filepath.Join(h.home, "lc-sessions", "*.json"))
	for _, file := range files {
		var session lcEngineSession
		if data, err := os.ReadFile(file); err == nil && json.Unmarshal(data, &session) == nil {
			sessions[strings.TrimSuffix(filepath.Base(file), ".json")] = session
		}
	}
	var requests []map[string]interface{}
	for _, rec := range h.records() {
		entry := map[string]interface{}{"pid": rec.PID}
		if rec.Note != "" {
			entry["note"], entry["fields"] = rec.Note, rec.Fields
		} else {
			entry["method"], entry["id"] = rec.Msg["method"], rec.Msg["id"]
			if result, ok := rec.Msg["result"]; ok {
				entry["result"] = result
			}
		}
		requests = append(requests, entry)
	}
	var transcript []map[string]interface{}
	for _, event := range h.events.snapshot() {
		entry := map[string]interface{}{"turn": event.turn, "type": event.typ}
		for _, key := range []string{"subtype", "status", "isError", "toolCallId", "text", "message", "stopReason"} {
			if value, ok := event.payload[key]; ok {
				entry[key] = value
			}
		}
		transcript = append(transcript, entry)
	}
	ledger, _ := loadDshTurnLedger(h.home)
	data, _ := json.MarshalIndent(map[string]interface{}{"scenario": name, "controlPlaneTurns": rows,
		"engineSessionLogs": sessions, "engineRequests": requests, "sideEffects": h.effectLines(),
		"runnerTurnLedger": ledger, "orbitTranscript": transcript}, "", "  ")
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, strings.ReplaceAll(name, "/", "__")+".json"), append(data, '\n'), 0o644)
}

type lcEngineSession struct {
	Cwd     string   `json:"cwd"`
	History []string `json:"history"`
}

// A reparented zombie still answers kill(0); it runs nothing, so it counts as gone.
func lcProcessAlive(pid int) bool {
	if syscall.Kill(pid, 0) != nil {
		return false
	}
	stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return true
	}
	fields := strings.Fields(string(stat[strings.LastIndexByte(string(stat), ')')+1:]))
	return len(fields) == 0 || fields[0] != "Z"
}

func lcWaitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// enginePIDs lists the synthetic dsh processes that served a request, in launch order.
func (h *lcHarness) enginePIDs() []int {
	var pids []int
	seen := map[int]bool{}
	for _, rec := range h.records() {
		if !seen[rec.PID] {
			seen[rec.PID] = true
			pids = append(pids, rec.PID)
		}
	}
	return pids
}

// TestDshLifecycleHelperProcess is the synthetic dsh. Directives in the prompt text select a
// behaviour; sessions persist under DSH_HOME so a new process can resume them with context.
func TestDshLifecycleHelperProcess(t *testing.T) {
	if os.Getenv("DSH_LC_HELPER") != "1" {
		return
	}
	home := os.Getenv("DSH_HOME")
	recordFile, err := os.OpenFile(os.Getenv("DSH_LC_RECORD"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		os.Exit(2)
	}
	var recordMu, outMu sync.Mutex
	record := func(rec lcRecord) {
		recordMu.Lock()
		defer recordMu.Unlock()
		rec.PID = os.Getpid()
		data, _ := json.Marshal(rec)
		_, _ = recordFile.Write(append(data, '\n'))
	}
	encoder := json.NewEncoder(os.Stdout)
	write := func(value map[string]interface{}) {
		outMu.Lock()
		defer outMu.Unlock()
		_ = encoder.Encode(value)
	}
	respond := func(id interface{}, result map[string]interface{}) {
		write(map[string]interface{}{"jsonrpc": "2.0", "id": id, "result": result})
	}
	respondError := func(id interface{}, code int, message string, data interface{}) {
		body := map[string]interface{}{"code": code, "message": message}
		if data != nil {
			body["data"] = data
		}
		write(map[string]interface{}{"jsonrpc": "2.0", "id": id, "error": body})
	}
	incoming := make(chan map[string]interface{}, 64)
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
		for scanner.Scan() {
			var msg map[string]interface{}
			if json.Unmarshal(scanner.Bytes(), &msg) != nil {
				os.Exit(2)
			}
			record(lcRecord{Msg: msg})
			incoming <- msg
		}
		close(incoming)
	}()
	sessionsDir := filepath.Join(home, "lc-sessions")
	load := func(id string) (lcEngineSession, bool) {
		var session lcEngineSession
		data, err := os.ReadFile(filepath.Join(sessionsDir, id+".json"))
		return session, err == nil && json.Unmarshal(data, &session) == nil
	}
	save := func(id string, session lcEngineSession) {
		_ = os.MkdirAll(sessionsDir, 0o700)
		data, _ := json.Marshal(session)
		_ = os.WriteFile(filepath.Join(sessionsDir, id+".json"), data, 0o600)
	}
	options := []interface{}{map[string]interface{}{"id": "model", "category": "model", "type": "select", "currentValue": "lc-model",
		"options": []interface{}{map[string]interface{}{"value": "lc-model", "name": "LC"}, map[string]interface{}{"value": "lc-model-2", "name": "LC 2"}}}}
	active := map[string]bool{}
	prompts := 0
	lastTool, lastMessage := "", ""
	// next reads the next client message; a second prompt while one is active is the
	// overlap real dsh rejects, so it is refused and recorded as a violation.
	next := func(activeSession string) map[string]interface{} {
		for msg := range incoming {
			if msg["method"] == "session/prompt" {
				record(lcRecord{Note: "violation", Fields: map[string]interface{}{"reason": "concurrent prompt"}})
				respondError(msg["id"], -32603, "a prompt is already active for "+activeSession, nil)
				continue
			}
			return msg
		}
		os.Exit(0)
		return nil
	}
	cwd, _ := os.Getwd()
	for msg := range incoming {
		id, params := msg["id"], mapValue(msg["params"])
		sessionID := firstString(params, "sessionId")
		switch msg["method"] {
		case "initialize":
			// The pinned CLI generates its acp profile on start; Seal hashes these files.
			profile := filepath.Join(home, "profiles", "acp")
			for _, name := range []string{"package.json", "pnpm-workspace.yaml", "cordis.patch.yml", "cordis.yml"} {
				if _, err := os.Stat(filepath.Join(profile, name)); os.IsNotExist(err) {
					_ = os.WriteFile(filepath.Join(profile, name), []byte("synthetic "+name+"\n"), 0o600)
				}
			}
			respond(id, map[string]interface{}{"protocolVersion": 1, "agentCapabilities": map[string]interface{}{}})
		case "session/new", "session/resume":
			if params["cwd"] != cwd || params["mcpServers"] == nil {
				respondError(id, -32602, "cwd does not match the session workspace", nil)
				continue
			}
			var owner dshConfigOwner
			data, _ := os.ReadFile(filepath.Join(home, "orbit-owner.json"))
			_ = json.Unmarshal(data, &owner)
			record(lcRecord{Note: "open", Fields: map[string]interface{}{"method": msg["method"], "profileSealed": owner.ProfileHash != "",
				"keySuffix": lcKeySuffix(os.Getenv("ORBIT_DSH_API_KEY")), "permissionMode": os.Getenv("DSH_PERMISSION_MODE")}})
			if msg["method"] == "session/new" {
				entries, _ := os.ReadDir(sessionsDir)
				sessionID = fmt.Sprintf("lc-engine-session-%d", len(entries)+1)
				save(sessionID, lcEngineSession{Cwd: cwd, History: []string{}})
			} else if session, ok := load(sessionID); !ok || session.Cwd != cwd {
				respondError(id, -32602, "session cannot be resumed", nil)
				continue
			}
			active[sessionID] = true
			respond(id, map[string]interface{}{"sessionId": sessionID, "configOptions": options})
		case "session/set_config_option":
			record(lcRecord{Note: "config", Fields: map[string]interface{}{"configId": params["configId"], "value": params["value"]}})
			respond(id, map[string]interface{}{"configOptions": options})
		case "session/close":
			delete(active, sessionID)
			respond(id, map[string]interface{}{})
		case "session/cancel":
			// No prompt is active: a no-op, as in dsh.
		case "session/prompt":
			session, ok := load(sessionID)
			if !active[sessionID] || !ok {
				respondError(id, -32602, "session is not active", nil)
				continue
			}
			blocks, _ := params["prompt"].([]interface{})
			text := firstString(mapValue(firstOf(blocks)), "text")
			prior := append([]string(nil), session.History...)
			session.History = append(session.History, text)
			save(sessionID, session) // the user turn is durable before any tool runs
			prompts++
			tool, message := fmt.Sprintf("lc-tool-%d-%d", os.Getpid(), prompts), fmt.Sprintf("lc-message-%d-%d", os.Getpid(), prompts)
			update := func(body map[string]interface{}) {
				write(map[string]interface{}{"jsonrpc": "2.0", "method": "session/update",
					"params": map[string]interface{}{"sessionId": sessionID, "update": body}})
			}
			toolStart := func(status string) {
				update(map[string]interface{}{"sessionUpdate": "tool_call", "toolCallId": tool, "title": "write", "kind": "edit",
					"status": status, "rawInput": map[string]interface{}{"turn": text}})
			}
			toolEnd := func(status string) {
				update(map[string]interface{}{"sessionUpdate": "tool_call_update", "toolCallId": tool, "status": status})
			}
			effect := func() {
				f, err := os.OpenFile(os.Getenv("DSH_LC_EFFECTS"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
				if err == nil {
					fmt.Fprintln(f, strings.Fields(text)[0])
					_ = f.Close()
				}
			}
			say := func(body string) {
				update(map[string]interface{}{"sessionUpdate": "agent_message_chunk", "messageId": message,
					"content": map[string]interface{}{"type": "text", "text": body}})
			}
			hang := func() {
				for {
					next(sessionID)
				}
			}
			if strings.Contains(text, "[late]") && lastTool != "" {
				// Stragglers from the settled previous turn, arriving inside this one.
				update(map[string]interface{}{"sessionUpdate": "tool_call_update", "toolCallId": lastTool, "status": "completed",
					"rawOutput": "late tool output"})
				update(map[string]interface{}{"sessionUpdate": "agent_message_chunk", "messageId": lastMessage,
					"content": map[string]interface{}{"type": "text", "text": "late previous-turn text"}})
			}
			lastTool, lastMessage = tool, message
			if strings.Contains(text, "[permission]") {
				toolStart("pending")
				permissionID := fmt.Sprintf("lc-permission-%d", prompts)
				write(map[string]interface{}{"jsonrpc": "2.0", "id": permissionID, "method": "session/request_permission",
					"params": map[string]interface{}{"sessionId": sessionID, "toolCall": map[string]interface{}{"toolCallId": tool},
						"options": []interface{}{map[string]interface{}{"optionId": "allow-once", "kind": "allow_once", "name": "Allow"},
							map[string]interface{}{"optionId": "reject-once", "kind": "reject_once", "name": "Reject"}}}})
				for {
					reply := next(sessionID)
					if reply["id"] != permissionID || reply["method"] != nil {
						continue
					}
					outcome := mapValue(mapValue(reply["result"])["outcome"])
					record(lcRecord{Note: "permission", Fields: map[string]interface{}{"outcome": outcome["outcome"], "optionId": outcome["optionId"]}})
					if outcome["outcome"] == "selected" && outcome["optionId"] == "allow-once" {
						effect()
						toolEnd("completed")
					} else {
						toolEnd("failed")
					}
					break
				}
				tool = tool + "-hold"
			}
			switch {
			case strings.Contains(text, "[hold]"):
				toolStart("in_progress")
				var closeID interface{}
				for {
					stop := next(sessionID)
					if (stop["method"] == "session/cancel" || stop["method"] == "session/close") && firstString(mapValue(stop["params"]), "sessionId") == sessionID {
						if stop["method"] == "session/close" {
							delete(active, sessionID)
							closeID = stop["id"]
						}
						break
					}
				}
				toolEnd("failed")
				if os.Getenv("DSH_LC_LATE_END") == "1" {
					// The model's answer races the cancel: the response says end_turn.
					say("answer racing the cancel")
					respond(id, map[string]interface{}{"stopReason": "end_turn"})
				} else {
					respond(id, map[string]interface{}{"stopReason": "cancelled"})
				}
				if closeID != nil {
					respond(closeID, map[string]interface{}{})
				}
			case strings.Contains(text, "[effect-hang]"):
				toolStart("in_progress")
				effect()
				record(lcRecord{Note: "effect-hang", Fields: map[string]interface{}{"tool": tool}})
				hang()
			case strings.Contains(text, "[crash]"):
				toolStart("in_progress")
				effect()
				os.Exit(0)
			case strings.Contains(text, "[child]"):
				child := exec.Command("sh", "-c", `while :; do echo tick >> "$0"; sleep 0.02; done`, os.Getenv("DSH_LC_CHILD")+".ticks")
				if err := child.Start(); err != nil {
					os.Exit(3)
				}
				_ = os.WriteFile(os.Getenv("DSH_LC_CHILD")+".pid", []byte(strconv.Itoa(child.Process.Pid)), 0o600)
				toolStart("in_progress")
				hang()
			case strings.Contains(text, "[max]"):
				say("truncated answer")
				respond(id, map[string]interface{}{"stopReason": "max_tokens"})
			case strings.Contains(text, "[rpcerr]"):
				key := os.Getenv("ORBIT_DSH_API_KEY")
				fmt.Fprintln(os.Stderr, "upstream rejected credential "+key)
				respondError(id, -32603, "401 invalid key "+key, map[string]interface{}{"apiKey": key})
			default:
				if strings.Contains(text, "[slow]") {
					time.Sleep(150 * time.Millisecond)
				}
				if strings.Contains(text, "[effect]") {
					toolStart("in_progress")
					effect()
					toolEnd("completed")
				}
				say(fmt.Sprintf("reply to %s after [%s]", strings.Fields(text)[0], strings.Join(lcFirstWords(prior), "|")))
				update(map[string]interface{}{"sessionUpdate": "usage_update", "used": 100 + prompts, "size": 1000})
				respond(id, map[string]interface{}{"stopReason": "end_turn"})
			}
		default:
			if id != nil {
				respondError(id, -32601, "unsupported synthetic method", nil)
			}
		}
	}
	os.Exit(0)
}

// Only a suffix of the synthetic key is recorded, so recordings never hold a key-shaped value.
func lcKeySuffix(key string) string {
	if len(key) < 4 {
		return key
	}
	return key[len(key)-4:]
}

func firstOf(values []interface{}) interface{} {
	if len(values) == 0 {
		return nil
	}
	return values[0]
}

func lcFirstWords(texts []string) []string {
	out := make([]string, 0, len(texts))
	for _, text := range texts {
		if fields := strings.Fields(text); len(fields) > 0 {
			out = append(out, fields[0])
		}
	}
	return out
}

// settledOnce reads one settled control-plane row and its single completion.
func (h *lcHarness) settledOnce(id, status, result string) TurnCompleteRequest {
	h.t.Helper()
	turn := h.cp.waitSettled(h.t, id)
	if turn.Status != status || len(turn.Completions) != 1 {
		h.t.Fatalf("turn %s = %s with %d completions, want one %s: %+v", id, turn.Status, len(turn.Completions), status, turn.Completions)
	}
	completion := turn.Completions[0]
	if result != "" && completion.Result != result {
		h.t.Fatalf("turn %s result = %q, want %q", id, completion.Result, result)
	}
	return completion
}

func (h *lcHarness) checkNoEngineViolations() {
	h.t.Helper()
	if violations := h.notes("violation"); len(violations) > 0 {
		h.t.Fatalf("synthetic dsh saw overlapping prompts: %+v", violations)
	}
}

func (h *lcHarness) end(run *lcRun, id string) {
	h.t.Helper()
	h.cp.add(id, "end", "")
	run.wait(h.t)
	if run.status != stSucceeded || !run.ended || run.reload {
		h.t.Fatalf("explicit end = %s ended=%v reload=%v", run.status, run.ended, run.reload)
	}
}

func lcEqual(t *testing.T, what string, got, want []string) {
	t.Helper()
	if strings.Join(got, "\x00") != strings.Join(want, "\x00") || len(got) != len(want) {
		t.Fatalf("%s = %q, want %q", what, got, want)
	}
}

func TestDshLifecycleMultiTurnQueue(t *testing.T) {
	t.Run("orbit-queue-and-redelivery", func(t *testing.T) {
		h := newLCHarness(t)
		h.cp.add("t1", "message", "m1 [slow]")
		h.cp.add("t2", "message", "m2")
		h.cp.add("t3", "message", "m3 [effect]")
		run := h.start(h.job())
		lcWaitFor(t, "first prompt", func() bool { return h.count("session/prompt") >= 1 })
		// t1's lease expires while it runs; the redelivery must not become a second prompt.
		h.cp.redeliver("t1")
		h.settledOnce("t1", stSucceeded, "reply to m1 after []")
		h.settledOnce("t2", stSucceeded, "reply to m2 after [m1]")
		last := h.settledOnce("t3", stSucceeded, "reply to m3 after [m1|m2]")
		h.end(run, "end")
		if last.RuntimeSessionID != "lc-engine-session-1" || h.cp.turn("t1").Deliveries != 2 {
			t.Fatalf("runtime id or redelivery: %+v deliveries=%d", last, h.cp.turn("t1").Deliveries)
		}
		lcEqual(t, "engine prompts", h.promptTexts(), []string{"m1 [slow]", "m2", "m3 [effect]"})
		lcEqual(t, "engine session log", h.sessionLog("lc-engine-session-1").History, []string{"m1 [slow]", "m2", "m3 [effect]"})
		lcEqual(t, "side effects", h.effectLines(), []string{"m3"})
		for _, id := range []string{"t1", "t2", "t3"} {
			h.checkTurnTranscript(id, true)
			if rec, ok := h.ledger().get(id); !ok || rec.State != dshTurnSettled || rec.Status != stSucceeded {
				t.Fatalf("ledger for %s: %+v", id, rec)
			}
		}
		h.checkNoEngineViolations()
		h.cp.checkClean(t)
		h.recordEvidence(t.Name())
	})
	t.Run("runner-local-queue", func(t *testing.T) {
		h := newLCHarness(t)
		h.cp.busyDelivery = true // every message is handed over at once; the runner must hold them
		h.cp.add("t1", "message", "m1 [slow]")
		h.cp.add("t2", "message", "m2 [slow]")
		h.cp.add("t3", "message", "m3")
		run := h.start(h.job())
		h.settledOnce("t1", stSucceeded, "reply to m1 after []")
		h.settledOnce("t2", stSucceeded, "reply to m2 after [m1]")
		h.settledOnce("t3", stSucceeded, "reply to m3 after [m1|m2]")
		h.end(run, "end")
		lcEqual(t, "engine prompts", h.promptTexts(), []string{"m1 [slow]", "m2 [slow]", "m3"})
		h.checkNoEngineViolations()
		h.cp.checkClean(t)
		h.recordEvidence(t.Name())
	})
	t.Run("unsupported-turns-reach-a-terminal", func(t *testing.T) {
		h := newLCHarness(t)
		h.cp.add("s1", "shell", "ls")
		h.cp.add("t1", "message", "m1")
		run := h.start(h.job())
		shell := h.cp.waitSettled(t, "s1")
		if shell.Status != stFailed || len(shell.Completions) != 1 || shell.Completions[0].Subtype != subtypeUnknownKind {
			t.Fatalf("shell turn must settle once without ending the session: %+v", shell)
		}
		h.settledOnce("t1", stSucceeded, "reply to m1 after []")
		h.end(run, "end")
		lcEqual(t, "engine prompts", h.promptTexts(), []string{"m1"})
		h.cp.checkClean(t)
	})
	// D3: a task's EXECUTABLE acceptance command is the runner's to run, in the worktree, after the
	// message ahead of it — never a prompt to dsh — while a person's `!` shell is still refused.
	t.Run("task-acceptance-runs-on-the-runner", func(t *testing.T) {
		h := newLCHarness(t)
		h.cp.busyDelivery = true // the acceptance turn arrives while the message is still running
		h.cp.add("t1", "message", "m1 [slow]")
		h.cp.addTurn(&lcTurn{ID: "a1", Kind: "shell", TaskAcceptance: true,
			Content: "pwd > acceptance-ran.txt; ls -A acceptance-ran.txt; echo d3-acceptance-output; exit 3"})
		h.cp.add("s1", "shell", "touch user-shell-ran.txt")
		run := h.start(h.job())
		h.settledOnce("t1", stSucceeded, "reply to m1 after []")
		acceptance := h.cp.waitSettled(t, "a1")
		if len(acceptance.Completions) != 1 {
			t.Fatalf("acceptance must settle once: %+v", acceptance)
		}
		done := acceptance.Completions[0]
		if done.Status != stSucceeded || done.Subtype != "shell" || done.ShellExitCode == nil || *done.ShellExitCode != 3 ||
			done.ShellOutput == nil || !strings.Contains(*done.ShellOutput, "d3-acceptance-output") ||
			done.Result != "exit 3" || done.RuntimeSessionID != "lc-engine-session-1" {
			t.Fatalf("acceptance completion: %+v (output %v)", done, done.ShellOutput)
		}
		ran, err := os.ReadFile(filepath.Join(h.work, "acceptance-ran.txt"))
		if err != nil {
			t.Fatalf("the acceptance command did not run in the worktree: %v", err)
		}
		if want, _ := filepath.EvalSymlinks(h.work); strings.TrimSpace(string(ran)) != want && strings.TrimSpace(string(ran)) != h.work {
			t.Fatalf("acceptance ran in %q, not the worktree %q", ran, h.work)
		}
		user := h.cp.waitSettled(t, "s1")
		if user.Status != stFailed || len(user.Completions) != 1 || user.Completions[0].Subtype != subtypeUnknownKind ||
			user.Completions[0].ShellExitCode != nil {
			t.Fatalf("a person's shell turn must still be refused: %+v", user)
		}
		if _, err := os.Stat(filepath.Join(h.work, "user-shell-ran.txt")); !os.IsNotExist(err) {
			t.Fatalf("a refused shell turn ran: %v", err)
		}
		h.end(run, "end")
		lcEqual(t, "engine prompts", h.promptTexts(), []string{"m1 [slow]"})
		h.checkNoEngineViolations()
		h.cp.checkClean(t)
	})
}

func TestDshLifecycleInterrupt(t *testing.T) {
	interrupt := func(t *testing.T, h *lcHarness, prompt string) *lcRun {
		h.cp.add("t1", "message", prompt)
		run := h.start(h.job())
		lcWaitFor(t, "held tool", func() bool {
			for _, event := range h.turnEvents("t1") {
				if event.typ == evToolUse && event.payload["status"] == "in_progress" {
					return true
				}
			}
			return false
		})
		h.cp.add("i1", "interrupt", "")
		completion := h.settledOnce("t1", stInterrupted, "")
		if completion.Subtype != "interrupted" || completion.RuntimeSessionID != "lc-engine-session-1" {
			t.Fatalf("interrupt settlement: %+v", completion)
		}
		events := h.checkTurnTranscript("t1", true)
		failed := 0
		for _, event := range events {
			if event.typ == evToolResult && event.payload["isError"] == true {
				failed++
			}
		}
		if failed == 0 || h.count("session/cancel") != 1 {
			t.Fatalf("cancelled tool must fail and one session/cancel must be sent: failed=%d methods=%v", failed, h.methods())
		}
		h.cp.add("t2", "message", "m2")
		h.settledOnce("t2", stSucceeded, "reply to m2 after [m1]")
		return run
	}
	t.Run("cancel-active-turn", func(t *testing.T) {
		h := newLCHarness(t)
		run := interrupt(t, h, "m1 [hold]")
		h.end(run, "end")
		if rec, _ := h.ledger().get("t1"); rec.State != dshTurnSettled || rec.Status != stInterrupted {
			t.Fatalf("ledger must record the interrupted settlement: %+v", rec)
		}
		h.checkNoEngineViolations()
		h.cp.checkClean(t)
		h.recordEvidence(t.Name())
	})
	t.Run("cancel-beats-racing-end_turn", func(t *testing.T) {
		h := newLCHarness(t)
		h.extraEnv = []string{"DSH_LC_LATE_END=1"}
		run := interrupt(t, h, "m1 [hold]")
		h.end(run, "end")
		h.cp.checkClean(t)
		h.recordEvidence(t.Name())
	})
	t.Run("approval-stop", func(t *testing.T) {
		h := newLCHarness(t)
		run := interrupt(t, h, "m1 [permission] [hold]")
		h.end(run, "end")
		permissions := h.notes("permission")
		if len(permissions) != 1 || permissions[0].Fields["outcome"] != "cancelled" {
			t.Fatalf("a pending approval must be answered cancelled exactly once: %+v", permissions)
		}
		if effects := h.effectLines(); len(effects) != 0 {
			t.Fatalf("a stopped approval produced a side effect: %v", effects)
		}
		for _, event := range h.turnEvents("t2") {
			if event.typ == evToolUse || event.typ == evToolResult {
				t.Fatalf("the stopped approval reached the next turn: %+v", event)
			}
		}
		h.cp.checkClean(t)
		h.recordEvidence(t.Name())
	})
}

func TestDshLifecycleSettlementPriority(t *testing.T) {
	t.Run("precedence-table", func(t *testing.T) {
		eof := fmt.Errorf("dsh ACP transport closed: EOF")
		rpc := fmt.Errorf("dsh session/prompt (-32603): synthetic")
		for _, tc := range []struct {
			name            string
			stopped         bool
			result          map[string]interface{}
			err             error
			status, subtype string
		}{
			{"stop-over-end_turn", true, map[string]interface{}{"stopReason": "end_turn"}, nil, stInterrupted, "interrupted"},
			{"stop-over-output-limit", true, map[string]interface{}{"stopReason": "max_tokens"}, nil, stInterrupted, "interrupted"},
			{"stop-over-protocol-error", true, nil, rpc, stInterrupted, "interrupted"},
			{"stop-over-exit", true, nil, eof, stInterrupted, "interrupted"},
			{"response-end_turn", false, map[string]interface{}{"stopReason": "end_turn"}, nil, stSucceeded, "completed"},
			{"response-output-limit", false, map[string]interface{}{"stopReason": "max_tokens"}, nil, stFailed, "max_tokens"},
			{"response-refusal", false, map[string]interface{}{"stopReason": "refusal"}, nil, stFailed, "refusal"},
			{"response-cancelled", false, map[string]interface{}{"stopReason": "cancelled"}, nil, stInterrupted, "interrupted"},
			{"protocol-error", false, nil, rpc, stFailed, "error"},
			{"exit-without-response", false, nil, eof, stFailed, "error"},
		} {
			mapper := newDshEventMapper("rt", func(string, string, map[string]interface{}) {})
			if err := mapper.begin(tc.name); err != nil {
				t.Fatal(err)
			}
			result, err := dshSettlementOutcome(tc.stopped, tc.result, tc.err)
			req, ok := mapper.settle(tc.name, result, err)
			if !ok || req.Status != tc.status || req.Subtype != tc.subtype {
				t.Fatalf("%s settled %s/%s, want %s/%s", tc.name, req.Status, req.Subtype, tc.status, tc.subtype)
			}
			if _, again := mapper.settle(tc.name, result, err); again {
				t.Fatalf("%s settled twice", tc.name)
			}
		}
	})
	t.Run("output-limit-and-protocol-error", func(t *testing.T) {
		h := newLCHarness(t)
		h.cp.add("t1", "message", "m1 [max]")
		h.cp.add("t2", "message", "m2 [rpcerr]")
		h.cp.add("t3", "message", "m3")
		run := h.start(h.job())
		if c := h.settledOnce("t1", stFailed, ""); c.Subtype != "max_tokens" {
			t.Fatalf("output limit: %+v", c)
		}
		if c := h.settledOnce("t2", stFailed, ""); c.Subtype != "error" || !strings.Contains(c.Error, "-32603") {
			t.Fatalf("protocol error: %+v", c)
		}
		h.settledOnce("t3", stSucceeded, "reply to m3 after [m1|m2]")
		h.end(run, "end")
		h.cp.checkClean(t)
		h.recordEvidence(t.Name())
	})
	t.Run("exit-without-response", func(t *testing.T) {
		h := newLCHarness(t)
		h.cp.add("t1", "message", "m1 [crash]")
		run := h.start(h.job())
		completion := h.settledOnce("t1", stFailed, "")
		run.wait(t)
		if run.status != stFailed || !run.ended || run.reload || completion.Error == "" {
			t.Fatalf("exit without response = %s ended=%v reload=%v completion=%+v", run.status, run.ended, run.reload, completion)
		}
		h.checkTurnTranscript("t1", true)
		exited := 0
		for _, event := range h.events.snapshot() {
			if event.typ == evSystem && event.payload["subtype"] == "process_exited" {
				exited++
			}
		}
		if exited != 1 || h.count("session/prompt") != 1 {
			t.Fatalf("exit must be reported once without replay: exited=%d prompts=%d", exited, h.count("session/prompt"))
		}
		lcEqual(t, "side effects", h.effectLines(), []string{"m1"})
		h.cp.checkClean(t)
		h.recordEvidence(t.Name())
	})
	t.Run("stop-beats-exit", func(t *testing.T) {
		h := newLCHarness(t)
		h.cp.add("t1", "message", "m1 [effect-hang]")
		run := h.start(h.job())
		lcWaitFor(t, "wedged tool", func() bool { return len(h.notes("effect-hang")) == 1 })
		h.cp.add("i1", "interrupt", "")
		lcWaitFor(t, "cancel delivery", func() bool { return h.count("session/cancel") == 1 })
		// The wedged engine never answers the cancel; it dies instead.
		pid := h.notes("effect-hang")[0].PID
		if err := syscall.Kill(pid, syscall.SIGKILL); err != nil {
			t.Fatal(err)
		}
		h.settledOnce("t1", stInterrupted, "")
		run.wait(t)
		if run.status != stFailed || run.ended {
			t.Fatalf("an interrupted turn must leave the session resumable: %s ended=%v", run.status, run.ended)
		}
		h.checkTurnTranscript("t1", true)
		h.cp.checkClean(t)
		h.recordEvidence(t.Name())
	})
}

// TestDshLifecycleRunnerHelperProcess is a whole runner session loop in its own process, so a
// scenario can SIGKILL the runner mid-turn exactly as a crashed runner dies.
func TestDshLifecycleRunnerHelperProcess(t *testing.T) {
	if os.Getenv("DSH_LC_RUNNER") != "1" {
		return
	}
	dir, url := os.Getenv("DSH_LC_DIR"), os.Getenv("DSH_LC_CP")
	h := &lcHarness{t: t, dir: dir, work: filepath.Join(dir, "work"), home: filepath.Join(dir, "dsh-home"),
		scratch: filepath.Join(dir, "scratch"), record: filepath.Join(dir, "engine-requests.ndjson"),
		effects: filepath.Join(dir, "side-effects.log"), key: os.Getenv("DSH_LC_KEY")}
	prepareDshSessionLaunch = h.prepare
	transport := NewTransport(url, "synthetic-runner-token")
	complete := func(req TurnCompleteRequest, _ ...context.Context) error {
		data, _ := json.Marshal(req)
		resp, err := http.Post(url+"/lc-turn-complete", "application/json", strings.NewReader(string(data)))
		if err == nil {
			_ = resp.Body.Close()
		}
		return err
	}
	job := h.job()
	job.RuntimeSessionID = os.Getenv("DSH_LC_RUNTIME_ID")
	providerRuntimeFor(providerDsh).run(sessionProcessArgs{
		ctx: context.Background(), shutdownCtx: context.Background(), t: transport, job: job,
		leaseGeneration: "lc-generation", execDir: h.work, scratchDir: h.scratch,
		emit: func(string, map[string]interface{}) {}, emitFor: func(string, string, map[string]interface{}) {},
		setTurn: func(string) {}, completeTurn: complete, waitTurnPermit: func(context.Context) bool { return true },
		onLeaseLost: func(error) {},
	})
	os.Exit(0)
}

func (h *lcHarness) startRunnerProcess(runtimeID string) *exec.Cmd {
	h.t.Helper()
	exe, err := os.Executable()
	if err != nil {
		h.t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=^TestDshLifecycleRunnerHelperProcess$")
	cmd.Env = append(os.Environ(), "DSH_LC_RUNNER=1", "DSH_LC_DIR="+h.dir, "DSH_LC_CP="+h.cp.srv.URL+"/api",
		"DSH_LC_KEY="+h.key, "DSH_LC_RUNTIME_ID="+runtimeID)
	if err := cmd.Start(); err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	return cmd
}

func TestDshLifecycleCrashRestartRecovery(t *testing.T) {
	crash := func(t *testing.T, h *lcHarness, runner *exec.Cmd, turn, prompt string) int {
		h.cp.add(turn, "message", prompt)
		lcWaitFor(t, "side effect before the crash", func() bool { return len(h.notes("effect-hang")) == 1 })
		engine := h.notes("effect-hang")[0].PID
		if err := runner.Process.Signal(syscall.SIGKILL); err != nil {
			t.Fatal(err)
		}
		_, _ = runner.Process.Wait()
		// The orphaned engine reads EOF on stdin and exits; nothing keeps running for the turn.
		lcWaitFor(t, "orphaned engine exit", func() bool { return !lcProcessAlive(engine) })
		if row := h.cp.turn(turn); row.Status != "IN_FLIGHT" || len(row.Completions) != 0 {
			t.Fatalf("a killed runner cannot have settled %s: %+v", turn, row)
		}
		if rec, ok := h.ledger().get(turn); !ok || rec.State != dshTurnPrompted || len(rec.OpenTools) != 1 {
			t.Fatalf("the ledger must hold the prompted turn and its open tool: %+v", rec)
		}
		return engine
	}
	recoverAndContinue := func(t *testing.T, h *lcHarness, job *ClaimedSession, crashed string, want string) {
		run := h.start(job)
		h.cp.redeliver(crashed) // the dead runner's lease expires
		completion := h.settledOnce(crashed, stInterrupted, "")
		if !strings.Contains(completion.Error, "not replayed") || completion.RuntimeSessionID != "lc-engine-session-1" {
			t.Fatalf("recovered turn: %+v", completion)
		}
		events := h.turnEvents(crashed)
		if lcCount(events, evToolResult) != 1 || lcCount(events, evTurnEnd) != 1 || lcCount(events, evUser) != 0 {
			t.Fatalf("recovered turn must close its open tool and end once without a new prompt: %+v", events)
		}
		h.cp.add("next", "message", "after-restart")
		h.settledOnce("next", stSucceeded, want)
		h.end(run, "end")
		if h.count("session/new") != 1 || h.count("session/resume") != 1 {
			t.Fatalf("restart must resume the one engine session: %v", h.methods())
		}
		if len(h.enginePIDs()) != 2 {
			t.Fatalf("expected one engine before and one after the restart: %v", h.enginePIDs())
		}
		h.checkNoEngineViolations()
		h.cp.checkClean(t)
	}
	t.Run("runner-killed-mid-tool", func(t *testing.T) {
		h := newLCHarness(t)
		runner := h.startRunnerProcess("")
		h.cp.add("t1", "message", "m1")
		first := h.settledOnce("t1", stSucceeded, "reply to m1 after []")
		crash(t, h, runner, "t2", "m2 [effect-hang]")
		job := h.job()
		job.RuntimeSessionID = first.RuntimeSessionID // what the control plane stored
		recoverAndContinue(t, h, job, "t2", "reply to after-restart after [m1|m2]")
		lcEqual(t, "engine prompts", h.promptTexts(), []string{"m1", "m2 [effect-hang]", "after-restart"})
		lcEqual(t, "side effects", h.effectLines(), []string{"m2"})
		lcEqual(t, "engine session log", h.sessionLog("lc-engine-session-1").History, []string{"m1", "m2 [effect-hang]", "after-restart"})
		h.recordEvidence(t.Name())
	})
	t.Run("runtime-id-never-reported", func(t *testing.T) {
		h := newLCHarness(t)
		runner := h.startRunnerProcess("")
		crash(t, h, runner, "t1", "m1 [effect-hang]")
		// Orbit never heard the runtime id; the retained ledger still names it.
		recoverAndContinue(t, h, h.job(), "t1", "reply to after-restart after [m1]")
		lcEqual(t, "engine prompts", h.promptTexts(), []string{"m1 [effect-hang]", "after-restart"})
		lcEqual(t, "side effects", h.effectLines(), []string{"m1"})
		h.recordEvidence(t.Name())
	})
}

func TestDshLifecycleLeaseLoss(t *testing.T) {
	h := newLCHarness(t)
	h.cp.add("t1", "message", "m1 [child]")
	run := h.start(h.job())
	childFile := filepath.Join(h.dir, "child")
	lcWaitFor(t, "tool child", func() bool {
		data, err := os.ReadFile(childFile + ".ticks")
		return err == nil && len(data) > 0
	})
	pidData, err := os.ReadFile(childFile + ".pid")
	if err != nil {
		t.Fatal(err)
	}
	child, _ := strconv.Atoi(string(pidData))
	engine := h.enginePIDs()[0]
	h.cp.setLeaseLost(true)
	run.wait(t)
	if run.status != stFailed || !run.ended || run.leaseLost.Load() != 1 {
		t.Fatalf("lease loss = %s ended=%v losses=%d", run.status, run.ended, run.leaseLost.Load())
	}
	if lcProcessAlive(engine) || lcProcessAlive(child) {
		t.Fatalf("the old engine (%d) or its tool child (%d) survived the lease", engine, child)
	}
	before, _ := os.ReadFile(childFile + ".ticks")
	time.Sleep(200 * time.Millisecond)
	after, _ := os.ReadFile(childFile + ".ticks")
	if len(after) != len(before) {
		t.Fatal("an unowned side effect continued after the lease was lost")
	}
	if row := h.cp.turn("t1"); row.Status != "IN_FLIGHT" || len(row.Completions) != 0 {
		t.Fatalf("the old owner must not settle the new owner's turn: %+v", row)
	}
	if rec, _ := h.ledger().get("t1"); rec.State != dshTurnPrompted || len(rec.OpenTools) != 1 {
		t.Fatalf("lease loss must leave the prompted record for the next owner: %+v", rec)
	}
	h.cp.setLeaseLost(false)
	next := h.start(h.job())
	h.cp.redeliver("t1")
	if c := h.settledOnce("t1", stInterrupted, ""); !strings.Contains(c.Error, "not replayed") {
		t.Fatalf("new owner settlement: %+v", c)
	}
	h.cp.add("t2", "message", "m2")
	h.settledOnce("t2", stSucceeded, "reply to m2 after [m1]")
	h.end(next, "end")
	lcEqual(t, "engine prompts", h.promptTexts(), []string{"m1 [child]", "m2"})
	h.cp.checkClean(t)
	h.recordEvidence(t.Name())
}

func TestDshLifecycleLateEvents(t *testing.T) {
	t.Run("settled-turn-stragglers", func(t *testing.T) {
		h := newLCHarness(t)
		h.cp.add("t1", "message", "m1 [effect]")
		run := h.start(h.job())
		h.settledOnce("t1", stSucceeded, "reply to m1 after []")
		h.cp.add("t2", "message", "m2 [late]")
		h.settledOnce("t2", stSucceeded, "reply to m2 after [m1]")
		// A stale long-poll answer for the settled t1 arrives after it completed.
		h.cp.redeliver("t1")
		lcWaitFor(t, "stale redelivery", func() bool { return h.cp.turn("t1").Deliveries == 2 })
		h.end(run, "end")
		if h.count("session/prompt") != 2 || len(h.cp.turn("t1").Completions) != 1 {
			t.Fatalf("a settled turn was prompted or settled again: prompts=%d %+v", h.count("session/prompt"), h.cp.turn("t1"))
		}
		first := h.checkTurnTranscript("t1", true)
		second := h.checkTurnTranscript("t2", true)
		if lcCount(first, evToolResult) != 1 || lcCount(second, evToolResult) != 0 || lcCount(second, evAssistant) != 1 {
			t.Fatalf("late events crossed turns: t1=%+v t2=%+v", first, second)
		}
		lcEqual(t, "side effects", h.effectLines(), []string{"m1"})
		h.cp.checkClean(t)
		h.recordEvidence(t.Name())
	})
	t.Run("lost-completion-is-reported-again", func(t *testing.T) {
		h := newLCHarness(t)
		h.cp.drop = map[string]bool{"t1": true}
		h.cp.add("t1", "message", "m1 [effect]")
		run := h.start(h.job())
		lcWaitFor(t, "settled ledger", func() bool { rec, _ := h.ledger().get("t1"); return rec.State == dshTurnSettled })
		h.end(run, "end")
		job := h.job()
		next := h.start(job)
		h.cp.redeliver("t1")
		h.settledOnce("t1", stSucceeded, "reply to m1 after []")
		h.end(next, "end2")
		if h.count("session/prompt") != 1 {
			t.Fatalf("a settled turn whose completion was lost was replayed: %v", h.promptTexts())
		}
		lcEqual(t, "side effects", h.effectLines(), []string{"m1"})
		h.cp.checkClean(t)
		h.recordEvidence(t.Name())
	})
}

func TestDshLifecycleShutdownAndResume(t *testing.T) {
	h := newLCHarness(t)
	h.cp.add("t1", "message", "m1")
	run := h.start(h.job())
	first := h.settledOnce("t1", stSucceeded, "")
	h.cp.add("t2", "message", "m2 [hold]")
	lcWaitFor(t, "held prompt", func() bool { return h.count("session/prompt") == 2 })
	engine := h.enginePIDs()[0]
	run.shutdown()
	run.wait(t)
	if run.status != stCancelled || !run.ended {
		t.Fatalf("shutdown = %s ended=%v", run.status, run.ended)
	}
	h.settledOnce("t2", stInterrupted, "")
	if h.count("session/close") != 1 || lcProcessAlive(engine) {
		t.Fatalf("shutdown must close the session and end its process: %v alive=%v", h.methods(), lcProcessAlive(engine))
	}
	for _, kept := range []string{"orbit-owner.json", "orbit.patch.json", "orbit-turns.json", "profiles/acp/cordis.yml", "lc-sessions/lc-engine-session-1.json"} {
		if _, err := os.Stat(filepath.Join(h.home, kept)); err != nil {
			t.Fatalf("DSH_HOME lost %s on shutdown: %v", kept, err)
		}
	}
	job := h.job()
	job.RuntimeSessionID = first.RuntimeSessionID
	next := h.start(job)
	h.cp.add("t3", "message", "m3")
	h.settledOnce("t3", stSucceeded, "reply to m3 after [m1|m2]")
	h.cp.add("t4", "message", "m4 [hold]")
	lcWaitFor(t, "held prompt", func() bool { return h.count("session/prompt") == 4 })
	h.end(next, "end")
	h.settledOnce("t4", stInterrupted, "")
	lcEqual(t, "engine session log", h.sessionLog(first.RuntimeSessionID).History, []string{"m1", "m2 [hold]", "m3", "m4 [hold]"})
	h.cp.checkClean(t)
	h.recordEvidence(t.Name())
}

func TestDshLifecycleCredentialReload(t *testing.T) {
	h := newLCHarness(t)
	job := h.job()
	h.cp.add("t1", "message", "m1")
	run := h.start(job)
	h.settledOnce("t1", stSucceeded, "")
	// A model change is a live configuration change on the same process.
	h.cp.addTurn(&lcTurn{ID: "r-model", Kind: "reload", Content: `{"model":"lc-model-2"}`})
	lcWaitFor(t, "live model change", func() bool {
		for _, note := range h.notes("config") {
			if note.Fields["value"] == "lc-model-2" {
				return true
			}
		}
		return false
	})
	engine := h.enginePIDs()[0]
	rotated := "sk-p3b-synthetic-key-0002"
	h.cp.addTurn(&lcTurn{ID: "r-key", Kind: "reload", Content: `{}`, Env: map[string]string{"ORBIT_DSH_API_KEY": rotated}})
	run.wait(t)
	if run.status != stCancelled || run.ended || !run.reload || lcProcessAlive(engine) {
		t.Fatalf("a rotated key must end the old process and ask for a fresh launch: %s ended=%v reload=%v alive=%v",
			run.status, run.ended, run.reload, lcProcessAlive(engine))
	}
	// What the supervisor does next: Prepare again from the latest dispatch and resume.
	next := h.start(job)
	h.cp.add("t2", "message", "m2")
	h.settledOnce("t2", stSucceeded, "reply to m2 after [m1]")
	h.cp.addTurn(&lcTurn{ID: "r-mode", Kind: "reload", Content: `{"permissionMode":"default"}`})
	next.wait(t)
	if !next.reload {
		t.Fatal("a file-policy change must relaunch the engine")
	}
	readOnly := h.start(job)
	h.cp.add("t3", "message", "m3")
	h.settledOnce("t3", stSucceeded, "reply to m3 after [m1|m2]")
	// The latest dispatch no longer carries a key (an empty env is not representable on the wire).
	h.cp.addTurn(&lcTurn{ID: "r-revoke", Kind: "reload", Content: `{}`, Env: map[string]string{"ORBIT_DSH_BASE_URL": ""}})
	readOnly.wait(t)
	revoked := h.start(job)
	revoked.wait(t)
	if revoked.status != stFailed || !revoked.ended {
		t.Fatalf("a revoked key must fail before any launch: %s ended=%v", revoked.status, revoked.ended)
	}
	opens := h.notes("open")
	if len(opens) != 3 || opens[0].Fields["keySuffix"] != lcKeySuffix(h.key) || opens[1].Fields["keySuffix"] != lcKeySuffix(rotated) ||
		opens[2].Fields["permissionMode"] != "read-only" || opens[1].Fields["method"] != "session/resume" {
		t.Fatalf("engine launches must follow the latest dispatch: %+v", opens)
	}
	h.mu.Lock()
	prepared := append([]string(nil), h.prepared...)
	h.mu.Unlock()
	lcEqual(t, "prepared keys", prepared, []string{h.key, rotated, rotated, ""})
	lcEqual(t, "engine prompts", h.promptTexts(), []string{"m1", "m2", "m3"})
	h.cp.checkClean(t)
	h.recordEvidence(t.Name())
}

func TestDshLifecycleRedaction(t *testing.T) {
	h := newLCHarness(t)
	h.key = "sk-p3b-redaction-secret-777"
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout := os.Stdout
	os.Stdout = writer
	captured := make(chan string, 1)
	go func() {
		var b strings.Builder
		scanner := bufio.NewScanner(reader)
		for scanner.Scan() {
			b.WriteString(scanner.Text() + "\n")
		}
		captured <- b.String()
	}()
	h.cp.add("t1", "message", "m1 [rpcerr]")
	run := h.start(h.job())
	completion := h.settledOnce("t1", stFailed, "")
	h.end(run, "end")
	os.Stdout = stdout
	_ = writer.Close()
	logs := <-captured
	if strings.Contains(completion.Error, h.key) || !strings.Contains(completion.Error, "[redacted]") || !strings.Contains(completion.Error, "401") {
		t.Fatalf("RPC error must stay a failure without the key: %q", completion.Error)
	}
	if strings.Contains(logs, h.key) || !strings.Contains(logs, "upstream rejected credential [redacted]") {
		t.Fatalf("dsh stderr must be logged without the key: %q", logs)
	}
	for _, event := range h.events.snapshot() {
		if data, _ := json.Marshal(event.payload); strings.Contains(string(data), h.key) {
			t.Fatalf("an event carried the key: %+v", event)
		}
	}
	h.recordEvidence(t.Name())
}

func TestDshLifecycleWiring(t *testing.T) {
	t.Run("file-policy", func(t *testing.T) {
		// P4 policy: only modes dsh can enforce have a file policy; the rest are refused ("").
		for mode, want := range map[string]string{"": "workspace-write", "auto": "workspace-write", "default": "read-only",
			"dontAsk": "read-only", "plan": "", "acceptEdits": "", "bypassPermissions": ""} {
			if got := dshFileModeForPermission(mode); got != want {
				t.Fatalf("permission %q -> %q, want %q", mode, got, want)
			}
		}
	})
	t.Run("production-seam-reads-dispatch", func(t *testing.T) {
		job := &ClaimedSession{SessionID: lcSessionID, Agent: AgentExecConfig{Env: map[string]string{}}}
		if _, err := prepareDshSessionLaunch(context.Background(), job, t.TempDir()); err == nil || !strings.Contains(err.Error(), "DSH_CREDENTIAL_MISSING") {
			t.Fatalf("the production seam must read the dispatched key before anything else: %v", err)
		}
	})
	t.Run("canonical-cwd-seal-and-execdir", func(t *testing.T) {
		h := newLCHarness(t)
		link := filepath.Join(h.dir, "work-link")
		if err := os.Symlink(h.work, link); err != nil {
			t.Fatal(err)
		}
		h.cp.add("t1", "message", "m1")
		run := h.startIn(h.job(), link)
		h.settledOnce("t1", stSucceeded, "")
		h.end(run, "end")
		h.mu.Lock()
		dirs := append([]string(nil), h.preparedDirs...)
		h.mu.Unlock()
		lcEqual(t, "prepared execution dirs", dirs, []string{link})
		opens := h.notes("open")
		if len(opens) != 1 || opens[0].Fields["profileSealed"] != true || opens[0].Fields["permissionMode"] != "workspace-write" {
			t.Fatalf("Seal must precede session/new with the verified policy: %+v", opens)
		}
		methods := h.methods()
		if len(methods) < 2 || methods[0] != "initialize" || methods[1] != "session/new" {
			t.Fatalf("initialize, then Seal, then new: %v", methods)
		}
		meta := readSessionMeta(filepath.Join(h.scratch, "meta.json"))
		if meta == nil || meta.RuntimeSessionID != "lc-engine-session-1" {
			t.Fatalf("runtime id not persisted: %+v", meta)
		}
	})
	t.Run("launch-cwd-mismatch", func(t *testing.T) {
		h := newLCHarness(t)
		spec, _ := dshMockLaunchSpec(t, "multiturn")
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		var events dshProcessEvents
		status, ended, _ := runDshSessionProcess(sessionProcessArgs{ctx: ctx, shutdownCtx: ctx, job: h.job(), execDir: h.work,
			scratchDir: h.scratch, dshLaunchSpec: &spec, setTurn: func(string) {},
			emit: func(typ string, payload map[string]interface{}) { events.emit("", typ, payload) }})
		if status != stFailed || !ended || len(h.records()) != 0 {
			t.Fatalf("a launch for another cwd must fail before spawning: %s %v", status, ended)
		}
	})
	t.Run("resume-failure-never-opens-new", func(t *testing.T) {
		h := newLCHarness(t)
		job := h.job()
		job.RuntimeSessionID = "lc-engine-session-missing"
		run := h.start(job)
		run.wait(t)
		if run.status != stFailed || !run.ended || h.count("session/resume") != 1 || h.count("session/new") != 0 {
			t.Fatalf("a failed resume must fail, not silently start over: %s %v", run.status, h.methods())
		}
	})
	t.Run("runtime-id-conflict", func(t *testing.T) {
		h := newLCHarness(t)
		h.cp.add("t1", "message", "m1")
		run := h.start(h.job())
		h.settledOnce("t1", stSucceeded, "")
		h.end(run, "end")
		job := h.job()
		job.RuntimeSessionID = "lc-engine-session-other"
		conflict := h.start(job)
		conflict.wait(t)
		if conflict.status != stFailed || len(h.enginePIDs()) != 1 {
			t.Fatalf("a runtime id that disagrees with the retained state must fail before launch: %s pids=%v", conflict.status, h.enginePIDs())
		}
	})
}
