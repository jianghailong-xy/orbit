package main

// A recorded Cursor CLI `agent acp` for the session driver's tests (cursor_acp.go): this test binary,
// started through a shim as the session's Cursor CLI, replays one process of a P0 recording in
// testdata/cursor/<scenario>/<process>/ (see the README there) — the CLI's stdout as it was recorded,
// line by line — the way fake_kimi_acp_test.go stands in for `kimi acp`. TestMain dispatches to it.
//
// A recording holds both directions but no clock between them, so the replay is paced by what each
// line waits on:
//   - an answer to a request goes out once the runner has sent that request, matched by method in the
//     recorded order and given the runner's own id. A recorded request the runner did not send is
//     skipped, and so is its answer;
//   - a notification goes out with the next answer after it — it is what Cursor streamed while that
//     request ran — and those after the last answer go out at once (a title can follow its turn's end),
//     unless the CLI never answered a request, a prompt it was killed in: they are that request's stream;
//   - a request the CLI sends the client goes out as recorded, and the replay waits for the runner to
//     answer it, since the real CLI would wait forever (§4.2, §5.2);
//   - a prompt's recorded `cancelled` answer goes out once the runner has cancelled that prompt — with
//     session/cancel, or with another session/prompt, which cancels the one running (§3.2, §3.3) — the
//     only things the real CLI answers `cancelled` to.
//
// A process that ran two sessions is replayed as the one session the script names, with its
// sub-agents. What the runner wrote is kept in received.jsonl, each line with how much of the
// recording had gone out by then, and how the CLI was started in start.json. Like the real CLI it does
// not exit when stdin ends, only on SIGTERM (143) or SIGINT (130) (§3.4) — or, when the script says so,
// once its recording has gone out or where the replay holds: killed, as a crash, or with its stdout closed
// while it runs on. The same binary answers `agent models` the ways P0a recorded it (§9), each call noted
// in models.jsonl.
//
// A script can also have the CLI start, as its first prompt arrives, what a session's commands leave
// running (Spawn, scope.json): the processes a session's scope has to reclaim (session_scope.go).

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// fakeCursorACPDirEnv starts this test binary as the recorded Cursor CLI (TestMain), naming its directory.
const fakeCursorACPDirEnv = "ORBIT_FAKE_CURSOR_ACP_DIR"

type fakeCursorACPScript struct {
	// Recording is the process's directory under testdata/cursor.
	Recording string `json:"recording"`
	// Session, when set, is the one session of a recording that holds two.
	Session string `json:"session,omitempty"`
	// Exit ends the CLI once its recording has gone out, or HoldAfter holds it, and nothing waits on the
	// runner: "SIGKILL" kills it, as a crash does (§3.4, §12), and "close-stdout" closes its connection while
	// it runs on.
	Exit string `json:"exit,omitempty"`
	// Models is how `agent models` answers: "invalid-key" or "offline" as P0a recorded them
	// (failure-shapes-without-prompt), a catalogue otherwise.
	Models string `json:"models,omitempty"`
	// MatchParams matches a request to the first recorded one of its method with the same params — the
	// session id and working directory aside — before the first of its method.
	MatchParams bool `json:"matchParams,omitempty"`
	// IgnoreCancel is a CLI that no longer answers: a session/cancel cancels nothing.
	IgnoreCancel bool `json:"ignoreCancel,omitempty"`
	// Spawn starts, before the first prompt's stream goes out, the processes fakeCursorScope names. A
	// session/cancel then ends the command's process group, as Cursor ends a cancelled command's (§3.3),
	// unless IgnoreCancel.
	Spawn bool `json:"spawn,omitempty"`
	// CancelEndsPrompt answers a session/cancel the way the real CLI does whatever the recording holds:
	// the session's running prompt is answered `cancelled` at once, the rest of its recorded stream is
	// dropped, and a request it was waiting on the runner for is no longer waited on (§3.3, §5.2).
	CancelEndsPrompt bool `json:"cancelEndsPrompt,omitempty"`
	// Modes answers a session/set_mode the recording does not hold as the CLI answers one (§3.1): a
	// current_mode_update for the mode asked, then {}.
	Modes bool `json:"modes,omitempty"`
	// HoldAfter stops the replay once the runner has answered the request the CLI sent under this recorded
	// id, until the runner sends anything else: a stop, or the CLI ending, finds the turn still running — with
	// Exit, the CLI ends there.
	HoldAfter string `json:"holdAfter,omitempty"`
	// Config answers a session/set_config_option the recording does not hold with the same params the way
	// the recording shows the CLI answering one (§10), from the recording's own data: selecting a model
	// lists the mode, the model and that model's own options as the recording's cursor/list_available_models
	// lists them, at their defaults; setting an option moves its currentValue; and a model, option or value
	// the CLI does not list is refused -32602, as the recording refuses one. A set_config_option the
	// recording holds with the same params is replayed as recorded.
	Config bool `json:"config,omitempty"`
}

// fakeCursorScopeProcessEnv starts this test binary as one of the processes a Spawn script starts
// (runFakeCursorScopeProcess), naming which.
const fakeCursorScopeProcessEnv = "ORBIT_FAKE_CURSOR_SCOPE_PROCESS"

// fakeCursorScope is what a Spawn script started, as scope.json keeps it: what a session's commands
// leave running, in each of the places it can be.
type fakeCursorScope struct {
	CLI int `json:"cli"`
	// Helper is in the CLI's own process group, as its worker and MCP servers are.
	Helper int `json:"helper"`
	// Command runs in a process group and session of its own, as Cursor runs every command (detached,
	// §3.4); CommandChild is in its process group.
	Command      int `json:"command"`
	CommandChild int `json:"commandChild"`
	// Escaped is a process the command moved into a session of its own: out of the reach of anything
	// that ends the command's process group.
	Escaped int `json:"escaped"`
	// Daemon's parent exited as soon as it had started it: it is an orphan from the start.
	Daemon int `json:"daemon"`
}

// fakeCursorSpawn starts what fakeCursorScope names and writes scope.json, once every one is running.
// Each carries the CLI's environment, as Cursor's commands do (§8.3), but not the variable that makes
// this binary the CLI. It returns the command, whose process group a cancel ends.
func fakeCursorSpawn(dir string) (int, error) {
	self, err := os.Executable()
	if err != nil {
		return 0, err
	}
	var env []string
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, fakeCursorACPDirEnv+"=") {
			env = append(env, entry)
		}
	}
	scope := fakeCursorScope{CLI: os.Getpid()}
	helper := exec.Command("sleep", "600")
	helper.Env = env
	if err := helper.Start(); err != nil {
		return 0, err
	}
	go func() { _ = helper.Wait() }() // a CLI reaps what it started
	scope.Helper = helper.Process.Pid
	ready := filepath.Join(dir, "command.json")
	command := exec.Command(self)
	command.Env = append(append([]string{}, env...), fakeCursorScopeProcessEnv+"=command", fakeCursorScopeReadyEnv+"="+ready)
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := command.Start(); err != nil {
		return 0, err
	}
	go func() { _ = command.Wait() }()
	scope.Command = command.Process.Pid
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		data, err := os.ReadFile(ready)
		if err == nil {
			err = json.Unmarshal(data, &scope)
		}
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			return 0, fmt.Errorf("the command did not start its processes: %w", err)
		}
	}
	daemonize := exec.Command(self)
	daemonize.Env = append(append([]string{}, env...), fakeCursorScopeProcessEnv+"=daemonize")
	out, err := daemonize.Output()
	if err == nil {
		scope.Daemon, err = strconv.Atoi(strings.TrimSpace(string(out)))
	}
	if err != nil {
		return 0, fmt.Errorf("the daemon did not start: %w", err)
	}
	wire, err := json.Marshal(scope)
	if err == nil {
		err = writeFileAtomically(filepath.Join(dir, "scope.json"), wire, 0o600)
	}
	return scope.Command, err
}

// fakeCursorScopeReadyEnv names the file a "command" process writes the processes it started to.
const fakeCursorScopeReadyEnv = "ORBIT_FAKE_CURSOR_SCOPE_READY"

// runFakeCursorScopeProcess is one of the processes fakeCursorSpawn starts, by mode: "command" starts a
// child in its own process group and one in a session of its own, says so, and runs on as a long command
// does; "daemonize" starts one in a session of its own, prints its pid and exits. Every process here
// ends within ten minutes whatever happens to the test.
func runFakeCursorScopeProcess(mode string) int {
	switch mode {
	case "command":
		child, escaped := exec.Command("sleep", "600"), exec.Command("sleep", "600")
		escaped.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		for _, cmd := range []*exec.Cmd{child, escaped} {
			if err := cmd.Start(); err != nil {
				fmt.Fprintln(os.Stderr, "fake cursor command:", err)
				return 1
			}
			go func(cmd *exec.Cmd) { _ = cmd.Wait() }(cmd)
		}
		wire, _ := json.Marshal(map[string]int{"commandChild": child.Process.Pid, "escaped": escaped.Process.Pid})
		if err := writeFileAtomically(os.Getenv(fakeCursorScopeReadyEnv), wire, 0o600); err != nil {
			fmt.Fprintln(os.Stderr, "fake cursor command:", err)
			return 1
		}
		time.Sleep(10 * time.Minute)
		return 0
	case "daemonize":
		daemon := exec.Command("sleep", "600")
		daemon.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		if err := daemon.Start(); err != nil {
			fmt.Fprintln(os.Stderr, "fake cursor daemon:", err)
			return 1
		}
		fmt.Println(daemon.Process.Pid)
		return 0
	}
	return 2
}

// fakeCursorModelsCall is one `agent models` the fake answered, as models.jsonl keeps it.
type fakeCursorModelsCall struct {
	APIKey bool `json:"apiKey"` // whether it was asked with a CURSOR_API_KEY
}

type fakeCursorRequest struct {
	id, method string
	session    string
	params     map[string]interface{}
	unanswered bool // the recording holds no answer to it
}

// fakeCursorLine is one recorded line of the CLI's stdout.
type fakeCursorLine struct {
	msg    map[string]interface{}
	answer string // the recorded id of the client request this line answers; "" when it answers none
	ask    string // the id of the request the CLI sends the client on this line; "" when it sends none
}

// fakeCursorReceived is one line the runner wrote, with how many recorded lines had gone out before it.
type fakeCursorReceived struct {
	Message map[string]interface{} `json:"message"`
	Emitted int                    `json:"emitted"`
}

func readFakeCursorJSONL(path string) ([]map[string]interface{}, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var messages []map[string]interface{}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var msg map[string]interface{}
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		messages = append(messages, msg)
	}
	return messages, nil
}

// loadFakeCursorReplay reads a recorded process, kept to one session when the script names one.
func loadFakeCursorReplay(script fakeCursorACPScript) ([]fakeCursorRequest, []fakeCursorLine, error) {
	sent, err := readFakeCursorJSONL(filepath.Join(script.Recording, "stdin.jsonl"))
	if err != nil {
		return nil, nil, err
	}
	written, err := readFakeCursorJSONL(filepath.Join(script.Recording, "stdout.jsonl"))
	if err != nil {
		return nil, nil, err
	}
	answers := map[string]map[string]interface{}{}
	for _, msg := range written {
		if msg["method"] == nil && msg["id"] != nil {
			answers[rpcIDKey(msg["id"])] = msg
		}
	}
	var requests []fakeCursorRequest
	requestSession := map[string]string{}
	for _, msg := range sent {
		method := asString(msg["method"])
		if method == "" || msg["id"] == nil {
			continue // a notification, or the recorded client's answer to the CLI's own request
		}
		id := rpcIDKey(msg["id"])
		session := firstString(mapValue(msg["params"]), "sessionId")
		if method == "session/new" {
			session = firstString(mapValue(answers[id]["result"]), "sessionId")
		}
		requestSession[id] = session
		_, answered := answers[id]
		requests = append(requests, fakeCursorRequest{id: id, method: method, session: session, params: mapValue(msg["params"]), unanswered: !answered})
	}
	toolSession, parentOf := map[string]string{}, map[string]string{}
	root := func(session string) string {
		for parentOf[session] != "" {
			session = parentOf[session]
		}
		return session
	}
	var lines []fakeCursorLine
	for _, msg := range written {
		params := mapValue(msg["params"])
		method := asString(msg["method"])
		line := fakeCursorLine{msg: msg}
		var session string
		switch {
		case method == "session/update":
			session = firstString(params, "sessionId")
			update := mapValue(params["update"])
			if id := firstString(update, "toolCallId"); id != "" {
				toolSession[id] = session
			}
			if child := firstString(update, "subagentSessionId"); child != "" && child != session {
				parentOf[child] = session
			}
		case method != "":
			line.ask = rpcIDKey(msg["id"])
			session = firstNonEmpty(firstString(params, "sessionId"), toolSession[firstString(params, "toolCallId")])
		default:
			line.answer = rpcIDKey(msg["id"])
			session = requestSession[line.answer]
		}
		if script.Session != "" && session != "" && root(session) != script.Session {
			continue
		}
		lines = append(lines, line)
	}
	if script.Session != "" {
		kept := requests[:0]
		for _, request := range requests {
			if request.session == "" || request.session == script.Session {
				kept = append(kept, request)
			}
		}
		requests = kept
	}
	return requests, lines, nil
}

func runFakeCursorACP(dir string) int {
	var script fakeCursorACPScript
	data, err := os.ReadFile(filepath.Join(dir, "script.json"))
	if err == nil {
		err = json.Unmarshal(data, &script)
	}
	if len(os.Args) > 1 && os.Args[1] == "models" {
		return fakeCursorReplayModels(dir, script.Models)
	}
	if len(os.Args) < 2 || os.Args[1] != "acp" {
		fmt.Println(cursorSupportedVersion)
		return 0
	}
	wd, _ := os.Getwd()
	if start, err := json.Marshal(fakeCursorCall{Args: os.Args[1:], Env: os.Environ(), Dir: wd, PID: os.Getpid()}); err == nil {
		_ = os.WriteFile(filepath.Join(dir, "start.json"), start, 0o600)
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		if <-signals == syscall.SIGINT {
			os.Exit(130)
		}
		os.Exit(143)
	}()
	// SIGUSR1 closes the connection while the CLI runs on, whatever it is waiting on — a request of its own the
	// runner has not answered among them, where Exit never ends it (cursorSignalReplay).
	hangUp := make(chan os.Signal, 1)
	signal.Notify(hangUp, syscall.SIGUSR1)
	go func() {
		<-hangUp
		_ = os.Stdout.Close()
	}()
	var requests []fakeCursorRequest
	var lines []fakeCursorLine
	if err == nil {
		requests, lines, err = loadFakeCursorReplay(script)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake cursor acp:", err)
		return 2
	}
	received, err := os.OpenFile(filepath.Join(dir, "received.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake cursor acp:", err)
		return 2
	}
	defer received.Close()
	// What a Config script answers from: every model the recording's catalogue lists, with its own options,
	// and the options the CLI last listed for the session.
	catalogue := map[string][]interface{}{}
	for _, line := range lines {
		models, _ := mapValue(line.msg["result"])["models"].([]interface{})
		for _, raw := range models {
			model := mapValue(raw)
			catalogue[firstString(model, "value")], _ = model["configOptions"].([]interface{})
		}
	}
	var options []interface{}
	out := bufio.NewWriter(os.Stdout)
	write := func(msg map[string]interface{}) {
		if listed, ok := mapValue(msg["result"])["configOptions"].([]interface{}); ok {
			options = listed
		}
		if line, err := json.Marshal(msg); err == nil {
			_, _ = out.Write(append(line, '\n'))
			_ = out.Flush()
		}
	}
	next := 0                        // the first recorded request neither matched nor skipped
	live := map[string]interface{}{} // recorded request id -> the id the runner sent it under
	skipped := map[string]bool{}     // recorded requests the runner did not send
	cursor := 0                      // the next recorded line to go out
	waiting := ""                    // the CLI's request still waiting for the runner's answer
	running := map[string]string{}   // recorded prompts sent and not answered yet -> their session
	cancelled := map[string]bool{}   // recorded prompts the runner cancelled
	unanswered := ""                 // the first recorded request the CLI never answered
	command := 0                     // the command a Spawn script started, which leads its process group
	held := false                    // HoldAfter's request was answered: nothing more goes out for now
	for _, request := range requests {
		if request.unanswered {
			unanswered = request.id
			break
		}
	}
	cancel := func(session string) {
		for id, s := range running {
			if s == session {
				cancelled[id] = true
			}
		}
	}
	pump := func() {
		for cursor < len(lines) && waiting == "" && !held {
			line := lines[cursor]
			if line.answer != "" && skipped[line.answer] {
				cursor++
				continue
			}
			anchored := false
			for _, later := range lines[cursor:] {
				if later.answer == "" || skipped[later.answer] {
					continue
				}
				if _, sent := live[later.answer]; !sent {
					return // this stretch went out while a request the runner has not sent yet ran
				}
				anchored = true
				break
			}
			if _, sent := live[unanswered]; !anchored && unanswered != "" && !sent && !skipped[unanswered] {
				return // the stream of the request the CLI never answered, which the runner has not sent yet
			}
			if line.answer != "" && firstString(mapValue(line.msg["result"]), "stopReason") == "cancelled" && !cancelled[line.answer] {
				return // the CLI answers a prompt `cancelled` only once it has been cancelled
			}
			msg := line.msg
			if line.answer != "" {
				msg = map[string]interface{}{}
				for key, value := range line.msg {
					msg[key] = value
				}
				msg["id"] = live[line.answer]
				delete(running, line.answer)
			}
			write(msg)
			cursor++
			waiting = line.ask
		}
		if (cursor == len(lines) || held) && waiting == "" {
			switch script.Exit {
			case "SIGKILL":
				_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
			case "close-stdout":
				script.Exit = ""
				_ = os.Stdout.Close()
			}
		}
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1<<20), 64<<20)
	for scanner.Scan() {
		var msg map[string]interface{}
		if json.Unmarshal(scanner.Bytes(), &msg) != nil {
			continue
		}
		if line, err := json.Marshal(fakeCursorReceived{Message: msg, Emitted: cursor}); err == nil {
			_, _ = received.Write(append(line, '\n'))
		}
		method, id := asString(msg["method"]), msg["id"]
		params := mapValue(msg["params"])
		if method != "" {
			held = false
		}
		switch {
		case method != "" && id != nil:
			match := -1
			configures := script.Config && method == "session/set_config_option"
			for i := next; i < len(requests) && (script.MatchParams || configures); i++ {
				if requests[i].method == method && fakeCursorSameParams(requests[i].params, params) {
					match = i
					break
				}
			}
			if match < 0 && configures {
				listed, refusal := fakeCursorConfigAnswer(options, catalogue, firstString(params, "configId"), firstString(params, "value"))
				if refusal != "" {
					write(map[string]interface{}{"jsonrpc": "2.0", "id": id, "error": map[string]interface{}{
						"code": -32602, "message": "Invalid params", "data": map[string]interface{}{"message": refusal}}})
				} else {
					write(map[string]interface{}{"jsonrpc": "2.0", "id": id, "result": map[string]interface{}{"configOptions": listed}})
				}
				continue
			}
			for i := next; i < len(requests) && match < 0; i++ {
				if requests[i].method == method {
					match = i
				}
			}
			if match < 0 && method == "session/set_mode" && script.Modes {
				write(map[string]interface{}{"jsonrpc": "2.0", "method": "session/update", "params": map[string]interface{}{
					"sessionId": firstString(params, "sessionId"),
					"update":    map[string]interface{}{"sessionUpdate": "current_mode_update", "currentModeId": firstString(params, "modeId")}}})
				write(map[string]interface{}{"jsonrpc": "2.0", "id": id, "result": map[string]interface{}{}})
				continue
			}
			if match < 0 {
				write(map[string]interface{}{"jsonrpc": "2.0", "id": id,
					"error": map[string]interface{}{"code": -32601, "message": "the recording has no further " + method}})
				continue
			}
			for _, request := range requests[next:match] {
				skipped[request.id] = true
			}
			live[requests[match].id] = id
			next = match + 1
			if method == "session/prompt" {
				// A prompt sent while another runs cancels that one (§3.2).
				session := firstString(params, "sessionId")
				cancel(session)
				running[requests[match].id] = session
				if script.Spawn && command == 0 {
					if command, err = fakeCursorSpawn(dir); err != nil {
						fmt.Fprintln(os.Stderr, "fake cursor acp:", err)
						return 2
					}
				}
			}
		case method == "session/cancel" && !script.IgnoreCancel:
			session := firstString(params, "sessionId")
			cancel(session)
			if command != 0 {
				_ = syscall.Kill(-command, syscall.SIGTERM)
			}
			for recorded, s := range running {
				if !script.CancelEndsPrompt || s != session {
					continue
				}
				// The prompt ends here: its answer goes out now, and what the recording streamed for it
				// after this point never does.
				for i := cursor; i < len(lines); i++ {
					if lines[i].answer == recorded {
						cursor = i + 1
						break
					}
				}
				write(map[string]interface{}{"jsonrpc": "2.0", "id": live[recorded], "result": map[string]interface{}{"stopReason": "cancelled"}})
				delete(running, recorded)
				waiting = ""
			}
		case id != nil:
			if rpcIDKey(id) == waiting {
				waiting = ""
			}
			if script.HoldAfter != "" && rpcIDKey(id) == script.HoldAfter {
				held = true
			}
		}
		pump()
	}
	time.Sleep(60 * time.Second)
	return 0
}

// fakeCursorConfigAnswer is the options a Config script's CLI lists once a session/set_config_option the
// recording does not hold has set id to value, or the refusal the CLI answers it with (§10). Selecting a
// model keeps the mode and the model, at its new value, and lists that model's own options from the
// catalogue in place of the last model's.
func fakeCursorConfigAnswer(options []interface{}, catalogue map[string][]interface{}, id, value string) ([]interface{}, string) {
	var listed []interface{}
	set := false
	for _, raw := range options {
		var option map[string]interface{}
		if wire, err := json.Marshal(raw); err != nil || json.Unmarshal(wire, &option) != nil {
			continue
		}
		switch other := firstString(option, "id"); {
		case other == id && !cursorOffers(option, value) && id == "model":
			return nil, "Invalid model value: " + value
		case other == id && !cursorOffers(option, value):
			return nil, "Invalid value for " + id + ": " + value
		case other == id:
			option["currentValue"] = value
			set = true
		case id == "model" && other != "mode":
			continue // the last model's own option
		}
		listed = append(listed, option)
	}
	if !set {
		return nil, "Invalid value for " + id + ": " + value
	}
	if id == "model" {
		listed = append(listed, catalogue[value]...)
	}
	return listed, ""
}

// fakeCursorSameParams is whether a request's params are a recorded one's, the session id and the working
// directory aside: those are the run's own.
func fakeCursorSameParams(recorded, sent map[string]interface{}) bool {
	strip := func(params map[string]interface{}) string {
		kept := map[string]interface{}{}
		for key, value := range params {
			if key != "sessionId" && key != "cwd" {
				kept[key] = value
			}
		}
		wire, _ := json.Marshal(kept)
		return string(wire)
	}
	return strip(recorded) == strip(sent)
}

// fakeCursorReplayModels is `agent models` answering as P0a recorded it (failure-shapes-without-prompt):
// a key Cursor refuses, an API it cannot reach, or the catalogue's first line.
func fakeCursorReplayModels(dir, mode string) int {
	if line, err := json.Marshal(fakeCursorModelsCall{APIKey: os.Getenv("CURSOR_API_KEY") != ""}); err == nil {
		if f, err := os.OpenFile(filepath.Join(dir, "models.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
			_, _ = f.Write(append(line, '\n'))
			_ = f.Close()
		}
	}
	switch mode {
	case "invalid-key":
		fmt.Fprintln(os.Stderr, "\x1b[33m⚠ Warning: The provided API key is invalid.\x1b[0m\n"+
			"The API key was loaded from the CURSOR_API_KEY environment variable.\n"+
			"Please check you have the right key, create a new one, or authenticate without it.")
		return 1
	case "offline":
		fmt.Fprintln(os.Stderr, "\x1b[31m✗ Failed to reach the Cursor API. If you are behind a corporate proxy, set the HTTPS_PROXY environment variable.\x1b[0m")
		return 1
	}
	fmt.Println("auto - Auto (default)")
	return 0
}

// cursorReplay is one recorded Cursor CLI a test starts a session on.
type cursorReplay struct {
	dir  string
	shim string // the executable the session's launch names
}

// newCursorReplay replays testdata/cursor/<recording> (scenario/process), kept to session when given.
func newCursorReplay(t *testing.T, recording, session string) *cursorReplay {
	t.Helper()
	return newCursorReplayScript(t, fakeCursorACPScript{Recording: recording, Session: session})
}

// newCursorReplayScript replays the recording script names (scenario/process, under testdata/cursor, or a
// test's own directory by its absolute path) the way the rest of the script says.
func newCursorReplayScript(t *testing.T, script fakeCursorACPScript) *cursorReplay {
	t.Helper()
	recording := script.Recording
	dir := t.TempDir()
	abs := recording
	if !filepath.IsAbs(abs) {
		var err error
		if abs, err = filepath.Abs(filepath.Join("testdata", "cursor", recording)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(filepath.Join(abs, "stdout.jsonl")); err != nil {
		t.Fatalf("no recording %s: %v", recording, err)
	}
	script.Recording = abs
	wire, err := json.Marshal(script)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "script.json"), wire, 0o600); err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	// The variable is the shim's, not the test process's, so nothing else a test starts becomes the fake.
	shim := filepath.Join(dir, cursorEntryPoint)
	body := "#!/bin/sh\nexport " + fakeCursorACPDirEnv + "=" + shellQuote(dir) + "\nexec " + shellQuote(self) + " \"$@\"\n"
	if err := os.WriteFile(shim, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return &cursorReplay{dir: dir, shim: shim}
}

// received is every line the runner wrote to the CLI, in order.
func (f *cursorReplay) received(t *testing.T) []fakeCursorReceived {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(f.dir, "received.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var lines []fakeCursorReceived
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var received fakeCursorReceived
		if err := json.Unmarshal([]byte(line), &received); err != nil {
			t.Fatalf("received.jsonl: %v", err)
		}
		lines = append(lines, received)
	}
	return lines
}

// requests is what the runner asked the CLI, by method, in order.
func (f *cursorReplay) requests(t *testing.T, method string) []fakeCursorReceived {
	t.Helper()
	var out []fakeCursorReceived
	for _, line := range f.received(t) {
		if asString(line.Message["method"]) == method && line.Message["id"] != nil {
			out = append(out, line)
		}
	}
	return out
}

// models is every `agent models` the fake answered, in order.
func (f *cursorReplay) models(t *testing.T) []fakeCursorModelsCall {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(f.dir, "models.jsonl"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var calls []fakeCursorModelsCall
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var call fakeCursorModelsCall
		if err := json.Unmarshal([]byte(line), &call); err != nil {
			t.Fatalf("models.jsonl: %v", err)
		}
		calls = append(calls, call)
	}
	return calls
}

// started is how the CLI was started: its arguments, environment and working directory.
func (f *cursorReplay) started(t *testing.T) fakeCursorCall {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(f.dir, "start.json"))
	if err != nil {
		t.Fatal(err)
	}
	var call fakeCursorCall
	if err := json.Unmarshal(data, &call); err != nil {
		t.Fatal(err)
	}
	return call
}
