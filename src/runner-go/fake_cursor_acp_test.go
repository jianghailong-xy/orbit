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
//     request ran — and those after the last answer go out at once (a title can follow its turn's end);
//   - a request the CLI sends the client goes out as recorded, and the replay waits for the runner to
//     answer it, since the real CLI would wait forever (§4.2, §5.2).
//
// A process that ran two sessions is replayed as the one session the script names, with its
// sub-agents. What the runner wrote is kept in received.jsonl, each line with how much of the
// recording had gone out by then, and how the CLI was started in start.json. Like the real CLI it does
// not exit when stdin ends, only on SIGTERM (143) or SIGINT (130) (§3.4).

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
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
}

type fakeCursorRequest struct {
	id, method string
	session    string
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
		requests = append(requests, fakeCursorRequest{id: id, method: method, session: session})
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
	var script fakeCursorACPScript
	data, err := os.ReadFile(filepath.Join(dir, "script.json"))
	if err == nil {
		err = json.Unmarshal(data, &script)
	}
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
	out := bufio.NewWriter(os.Stdout)
	write := func(msg map[string]interface{}) {
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
	pump := func() {
		for cursor < len(lines) && waiting == "" {
			line := lines[cursor]
			if line.answer != "" && skipped[line.answer] {
				cursor++
				continue
			}
			for _, later := range lines[cursor:] {
				if later.answer == "" || skipped[later.answer] {
					continue
				}
				if _, sent := live[later.answer]; !sent {
					return // this stretch went out while a request the runner has not sent yet ran
				}
				break
			}
			msg := line.msg
			if line.answer != "" {
				msg = map[string]interface{}{}
				for key, value := range line.msg {
					msg[key] = value
				}
				msg["id"] = live[line.answer]
			}
			write(msg)
			cursor++
			waiting = line.ask
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
		switch {
		case method != "" && id != nil:
			match := -1
			for i := next; i < len(requests); i++ {
				if requests[i].method == method {
					match = i
					break
				}
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
		case id != nil:
			if rpcIDKey(id) == waiting {
				waiting = ""
			}
		}
		pump()
	}
	time.Sleep(60 * time.Second)
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
	dir := t.TempDir()
	abs, err := filepath.Abs(filepath.Join("testdata", "cursor", recording))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(abs, "stdout.jsonl")); err != nil {
		t.Fatalf("no recording %s: %v", recording, err)
	}
	script, err := json.Marshal(fakeCursorACPScript{Recording: abs, Session: session})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "script.json"), script, 0o600); err != nil {
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
