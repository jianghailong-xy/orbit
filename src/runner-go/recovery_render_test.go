package main

import (
	"bytes"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

// The recovery renderer (recovery_render.go) is held here to the task's own bar: the same server answer
// reads the same code, effect, retry and action over MCP and at the CLI; the MCP text is what it always
// was; a failed --json command prints one JSON document; a suggested CLI call is an absolute argv plus
// stdin; and no step is offered as an invoke this process cannot run.

// recoveryRenderEnv is a headless runner with no session, so the test does not read this machine's own.
func recoveryRenderEnv(t *testing.T, serverURL string) {
	t.Helper()
	for _, k := range []string{"ORBIT_SESSION_ID", "ORBIT_AGENT_ID", "ORBIT_TASK_ID", envMCPOrchestration, "ORBIT_WATCHES", "ORBIT_WIKI", envOrchestrationToken} {
		t.Setenv(k, "")
	}
	configureCLITestRunner(t, serverURL)
}

func recoveryFixtureServer(c recoveryContractCase) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for k, v := range c.Input.Headers {
			w.Header().Set(k, v)
		}
		w.WriteHeader(c.Input.Status)
		_, _ = w.Write([]byte(c.Input.Body))
	}))
}

func decodeMCPReport(t *testing.T, result map[string]interface{}) recoveryReport {
	t.Helper()
	raw, ok := result["structuredContent"]
	if !ok {
		t.Fatalf("no structuredContent on a failed result: %v", result)
	}
	data, _ := json.Marshal(raw)
	var report recoveryReport
	if err := json.Unmarshal(data, &report); err != nil {
		t.Fatal(err)
	}
	return report
}

// runCLIForReport runs one CLI command the way runCLICommand does, without exiting, and returns what it
// printed on each stream.
func runCLIForReport(t *testing.T, argv []string, stdin string, replayStdin bool, run func(in *cliStdinRecorder, out *bytes.Buffer) error) (string, string) {
	t.Helper()
	mark := markTransportActivity()
	in := &cliStdinRecorder{r: strings.NewReader(stdin)}
	var out, stdout, stderr bytes.Buffer
	err := run(in, &out)
	if err == nil {
		t.Fatalf("%v succeeded: %s", argv, out.String())
	}
	writeCLIFailure("orbit "+argv[0], err, mark, argv, in, replayStdin, &stdout, &stderr)
	return stdout.String(), stderr.String()
}

func decodeCLIReport(t *testing.T, stdout string) recoveryReport {
	t.Helper()
	var report recoveryReport
	dec := json.NewDecoder(strings.NewReader(stdout))
	if err := dec.Decode(&report); err != nil {
		t.Fatalf("CLI failure is not one JSON document: %v\n%s", err, stdout)
	}
	if err := dec.Decode(new(interface{})); err != io.EOF {
		t.Fatalf("CLI failure printed more than one JSON document:\n%s", stdout)
	}
	return report
}

func comparableNext(n recoveryNext) map[string]interface{} {
	return map[string]interface{}{"type": n.Type, "actionCode": n.ActionCode, "afterSeconds": n.AfterSeconds}
}

func TestRecoveryReportIsTheSameOverMCPAndCLIForEveryFixture(t *testing.T) {
	exe := orbitCLIExecutable()
	if exe == "" || !filepath.IsAbs(exe) {
		t.Fatalf("test executable %q is not absolute", exe)
	}
	checked := 0
	for _, c := range loadRecoveryFixtures(t) {
		if c.Input.Source != "HTTP" || (c.Input.Status >= 200 && c.Input.Status < 300) || c.Input.RequestIDSent {
			continue
		}
		checked++
		t.Run(c.Name, func(t *testing.T) {
			srv := recoveryFixtureServer(c)
			defer srv.Close()
			recoveryRenderEnv(t, srv.URL)

			// What the contract reads from this answer, as the transport keeps it (Retry-After only).
			headers := map[string]string{}
			for k, v := range c.Input.Headers {
				if strings.EqualFold(k, "Retry-After") {
					headers["Retry-After"] = v
				}
			}
			want, ok := parseRecovery(recoveryObservation{Source: "HTTP", Status: c.Input.Status, Headers: headers, Body: c.Input.Body})
			if !ok {
				t.Fatal("fixture is not a failure")
			}

			mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}
			result := mcp.callTool("task_get", map[string]interface{}{"taskId": "T1"})
			if result["isError"] != true {
				t.Fatalf("isError = %v", result["isError"])
			}
			legacy := "get task failed: " + (&transportHTTPError{method: "GET", path: "/runner/tasks/T1", statusCode: c.Input.Status,
				body: c.Input.Body, retryAfter: headers["Retry-After"]}).Error()
			content := result["content"].([]map[string]interface{})
			if len(content) != 1 || content[0]["text"] != legacy {
				t.Fatalf("MCP text changed:\n got %v\nwant %q", content, legacy)
			}
			mcpReport := decodeMCPReport(t, result)
			if !reflect.DeepEqual(mcpReport.Error, want) {
				got, _ := json.Marshal(mcpReport.Error)
				exp, _ := json.Marshal(want)
				t.Fatalf("MCP envelope:\n got %s\nwant %s", got, exp)
			}

			argv := []string{"task", "get", "T1", "--json"}
			stdout, stderr := runCLIForReport(t, argv, "", true, func(in *cliStdinRecorder, out *bytes.Buffer) error {
				return cmdTaskCLI(argv[1:], in, out)
			})
			if stderr != "" {
				t.Fatalf("--json failure wrote to stderr: %q", stderr)
			}
			cliReport := decodeCLIReport(t, stdout)
			if cliReport.OK || mcpReport.OK {
				t.Fatal("a failure reported ok")
			}
			if !reflect.DeepEqual(cliReport.Error, mcpReport.Error) {
				t.Fatalf("CLI and MCP envelopes differ:\n cli %+v\n mcp %+v", cliReport.Error, mcpReport.Error)
			}
			if !reflect.DeepEqual(comparableNext(cliReport.Next), comparableNext(mcpReport.Next)) {
				t.Fatalf("next differs:\n cli %+v\n mcp %+v", cliReport.Next, mcpReport.Next)
			}
			if cliReport.Text != "orbit task: get task: "+strings.TrimPrefix(legacy, "get task failed: ") {
				t.Fatalf("CLI text = %q", cliReport.Text)
			}

			// Without --json the CLI prints exactly the line it always printed, and nothing on stdout.
			plain := []string{"task", "get", "T1"}
			stdout, stderr = runCLIForReport(t, plain, "", true, func(in *cliStdinRecorder, out *bytes.Buffer) error {
				return cmdTaskCLI(plain[1:], in, out)
			})
			if stdout != "" || stderr != cliReport.Text+"\n" {
				t.Fatalf("plain failure: stdout %q stderr %q", stdout, stderr)
			}

			if mcpReport.Next.Type != recoveryNextInvoke {
				if mcpReport.Next.Tool != "" || mcpReport.Next.Input != nil || cliReport.Next.Argv != nil || cliReport.Next.Stdin != nil {
					t.Fatalf("a %s step names a call: mcp %+v cli %+v", mcpReport.Next.Type, mcpReport.Next, cliReport.Next)
				}
				return
			}
			// The same step on each surface: the tool and its input, or the absolute argv for that command.
			if cliReport.Next.Argv[0] != exe || cliReport.Next.Stdin != nil {
				t.Fatalf("CLI invoke = %+v", cliReport.Next)
			}
			switch *mcpReport.Error.ActionCode {
			case "RETRY":
				if mcpReport.Next.Tool != "task_get" || !reflect.DeepEqual(mcpReport.Next.Input, map[string]interface{}{"taskId": "T1"}) ||
					!reflect.DeepEqual(cliReport.Next.Argv[1:], argv) {
					t.Fatalf("retry: mcp %+v cli %+v", mcpReport.Next, cliReport.Next)
				}
			case "VERIFY_STATE":
				r := mcpReport.Error.Resources[0]
				reader := recoveryReaders[r.Type]
				if mcpReport.Next.Tool != reader[0] || !reflect.DeepEqual(mcpReport.Next.Input, map[string]interface{}{reader[1]: r.ID}) ||
					!reflect.DeepEqual(cliReport.Next.Argv[1:], []string{strings.ToLower(r.Type), "get", r.ID, "--json"}) {
					t.Fatalf("verify: mcp %+v cli %+v", mcpReport.Next, cliReport.Next)
				}
			default:
				t.Fatalf("unexpected invoke for %v", *mcpReport.Error.ActionCode)
			}
		})
	}
	if checked < 20 {
		t.Fatalf("only %d fixtures checked", checked)
	}
}

// A request id in the call (an MCP argument or its CLI flag) reads the same on both surfaces.
func TestRecoveryRequestIDReadsTheSameOnBothSurfaces(t *testing.T) {
	if !mcpRequestIDSent(map[string]interface{}{"idempotencyKey": "k"}) || mcpRequestIDSent(map[string]interface{}{"idempotencyKey": " "}) ||
		!mcpRequestIDSent(map[string]interface{}{"clientTurnId": "c"}) || mcpRequestIDSent(map[string]interface{}{"taskId": "t"}) {
		t.Fatal("MCP request id")
	}

}

// A refusal this process makes before sending anything wrote nothing: both surfaces say so the same way,
// and the MCP text is the message it always was.
func TestRecoveryLocalRefusalIsTheSameOverMCPAndCLI(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("nothing should be sent: %s %s", r.Method, r.URL.Path)
	}))
	defer srv.Close()
	recoveryRenderEnv(t, srv.URL)

	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "S1"}
	result := mcp.callTool("task_evidence_decide", map[string]interface{}{"taskId": "T1", "decision": "MAYBE"})
	content := result["content"].([]map[string]interface{})
	if content[0]["text"] != "decision must be CONFIRM or SEND_BACK" {
		t.Fatalf("text = %v", content[0]["text"])
	}
	mcpReport := decodeMCPReport(t, result)

	argv := []string{"task", "evidence-decide", "T1", "--decision", "MAYBE", "--evidence-revision", "1", "--json"}
	stdout, _ := runCLIForReport(t, argv, "", true, func(in *cliStdinRecorder, out *bytes.Buffer) error {
		return cmdTaskCLI(argv[1:], in, out)
	})
	cliReport := decodeCLIReport(t, stdout)
	for _, r := range []recoveryReport{mcpReport, cliReport} {
		e := r.Error
		if e.Code != recoveryLocalRefusedCode || e.Kind != "VALIDATION" || e.Effect != "NONE" || e.Retry.Policy != "NEVER" ||
			e.ActionCode == nil || *e.ActionCode != "FIX_REQUEST" || r.Next.Type != recoveryNextManual {
			t.Fatalf("local refusal report = %+v", r)
		}
	}
}

// No answer at all: the outcome is unknown on both surfaces, and with nothing to read it is checked by hand.
func TestRecoveryNoAnswerIsUnknownOnBothSurfaces(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close()
	recoveryRenderEnv(t, url)

	mcp := &mcpServer{t: NewTransport(url, "tok")}
	mcpReport := decodeMCPReport(t, mcp.callTool("task_get", map[string]interface{}{"taskId": "T1"}))
	argv := []string{"task", "get", "T1", "--json"}
	stdout, _ := runCLIForReport(t, argv, "", true, func(in *cliStdinRecorder, out *bytes.Buffer) error {
		return cmdTaskCLI(argv[1:], in, out)
	})
	cliReport := decodeCLIReport(t, stdout)
	for _, r := range []recoveryReport{mcpReport, cliReport} {
		if r.Error.Code != "TRANSPORT_NO_ANSWER" || r.Error.Effect != "UNKNOWN" || r.Error.Retry.Policy != "VERIFY_THEN_RETRY" ||
			r.Next.Type != recoveryNextManual {
			t.Fatalf("no-answer report = %+v", r)
		}
	}
}

// The suggested CLI call carries the user's text as argv elements and stdin bytes, verbatim: never a
// shell string, so nothing in the text is ever interpreted.
func TestRecoveryCLIRetryIsAnArgvAndStdinNeverAShellString(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "2")
		w.WriteHeader(503)
		_, _ = w.Write([]byte(`{"statusCode":503,"code":"TRANSIENT_DB_CONFLICT","message":"try again","retryable":true}`))
	}))
	defer srv.Close()
	recoveryRenderEnv(t, srv.URL)

	title := `x"; rm -rf ~ #`
	description := "line one $(touch /tmp/pwned) `id`\n'quoted' \"double\"\n"
	argv := []string{"task", "create", "--title", title, "--description-file", "-", "--completion-criterion", "EVIDENCE_JUDGMENT",
		"--acceptance-criteria", "it works", "--json"}
	stdout, _ := runCLIForReport(t, argv, description, true, func(in *cliStdinRecorder, out *bytes.Buffer) error {
		return cmdTaskCLI(argv[1:], in, out)
	})
	report := decodeCLIReport(t, stdout)
	if report.Error.Code != "TRANSIENT_DB_CONFLICT" || report.Next.Type != recoveryNextInvoke ||
		report.Next.AfterSeconds == nil || *report.Next.AfterSeconds != 2 {
		t.Fatalf("report = %+v", report)
	}
	if !filepath.IsAbs(report.Next.Argv[0]) || !reflect.DeepEqual(report.Next.Argv[1:], argv) {
		t.Fatalf("argv = %q", report.Next.Argv)
	}
	if report.Next.Stdin == nil || *report.Next.Stdin != description {
		t.Fatalf("stdin = %v", report.Next.Stdin)
	}

	// A command whose stdin may hold a credential is never offered again with it.
	stdout, _ = runCLIForReport(t, argv, description, false, func(in *cliStdinRecorder, out *bytes.Buffer) error {
		return cmdTaskCLI(argv[1:], in, out)
	})
	if report := decodeCLIReport(t, stdout); report.Next.Type == recoveryNextInvoke || report.Next.Stdin != nil {
		t.Fatalf("credential stdin replayed: %+v", report.Next)
	}
}

type fakeRecoverySurface struct {
	readable map[string]bool
	canAgain bool
}

func (f fakeRecoverySurface) read(tool, idKey, id string) (recoveryNext, bool) {
	if !f.readable[tool] {
		return recoveryNext{}, false
	}
	return recoveryNext{Tool: tool, Input: map[string]interface{}{idKey: id}}, true
}

func (f fakeRecoverySurface) again() (recoveryNext, bool) {
	if !f.canAgain {
		return recoveryNext{}, false
	}
	return recoveryNext{Tool: "the_same_tool"}, true
}

// Every envelope the contract can produce, on a surface that exposes everything and on one that exposes
// nothing: an invoke appears only where the surface can run it, never past a required confirmation
// unless it only reads, and a missing capability degrades to ask_user, wait or manual.
func TestRecoveryNextNeverInvokesWhatIsNotExposed(t *testing.T) {
	var envs []recoveryEnvelope
	for _, c := range loadRecoveryFixtures(t) {
		if env, ok := parseRecovery(c.Input); ok {
			envs = append(envs, env)
		}
	}
	// Plus every combination a server block can state, as the invariant property test builds them.
	for _, effect := range recoveryEffects {
		for _, policy := range recoveryRetryPolicies {
			for _, action := range append([]string{""}, recoveryActionCodes...) {
				for _, confirm := range recoveryUserConfirmations {
					for _, resource := range []string{"", "TASK", "SESSION", "CROSSING"} {
						for _, sent := range []bool{false, true} {
							block := map[string]interface{}{"effect": effect, "retryPolicy": policy, "userConfirmation": confirm, "retryAfterSeconds": 3}
							if action != "" {
								block["actionCode"] = action
							}
							if resource != "" {
								block["resources"] = []map[string]string{{"type": resource, "id": "R1"}}
							}
							body, _ := json.Marshal(map[string]interface{}{"code": "X", "message": "m", "recovery": block})
							env, _ := parseRecovery(recoveryObservation{Source: "HTTP", Status: 409, Body: string(body), RequestIDSent: sent})
							envs = append(envs, env)
						}
					}
				}
			}
		}
	}
	everything := fakeRecoverySurface{readable: map[string]bool{"task_get": true, "session_get": true, "project_get": true}, canAgain: true}
	nothing := fakeRecoverySurface{}
	allowed := map[string]bool{recoveryNextInvoke: true, recoveryNextAskUser: true, recoveryNextWait: true, recoveryNextManual: true}
	for _, env := range envs {
		for _, sent := range []bool{false, true} {
			full := renderRecoveryNext(env, everything, sent)
			none := renderRecoveryNext(env, nothing, sent)
			if !allowed[full.Type] || !allowed[none.Type] || full.Reason == "" || none.Reason == "" {
				t.Fatalf("bad step for %+v: %+v / %+v", env, full, none)
			}
			if none.Type == recoveryNextInvoke {
				t.Fatalf("invoke on a surface that exposes nothing: %+v", none)
			}
			if !reflect.DeepEqual(full.ActionCode, env.ActionCode) || !reflect.DeepEqual(none.ActionCode, env.ActionCode) {
				t.Fatalf("step changed the actionCode: %+v vs %v", full, env.ActionCode)
			}
			if full.Type != recoveryNextInvoke {
				continue
			}
			action := *env.ActionCode
			reads := full.Tool != "the_same_tool"
			if reads && action != "VERIFY_STATE" {
				t.Fatalf("a read for %s", action)
			}
			if !reads {
				if action != "RETRY" && action != "RETRY_SAME_REQUEST" {
					t.Fatalf("a resend for %s", action)
				}
				if env.UserConfirmation == "REQUIRED" || env.Effect == "COMMITTED" {
					t.Fatalf("a resend past the boundary: %+v", env)
				}
				if action == "RETRY_SAME_REQUEST" && !sent {
					t.Fatalf("a same-id resend with no id: %+v", env)
				}
			}
		}
	}
}

// The real surfaces: a session reader that is not listed (orchestration off) or a CLI command that is not
// available here is never offered.
func TestRecoveryRealSurfacesOfferOnlyWhatTheyExpose(t *testing.T) {
	verify := "VERIFY_STATE"
	env := recoveryEnvelope{ActionCode: &verify, Effect: "UNKNOWN", UserConfirmation: "NOT_REQUIRED",
		Resources: []recoveryResource{{Type: "SESSION", ID: "S9"}}}
	mcp := &mcpServer{}
	names := map[string]bool{}
	for n := range mcp.listedTools() {
		names[n] = true
	}
	if names["session_get"] {
		t.Fatal("session_get listed without orchestration")
	}
	if n := renderRecoveryNext(env, mcpRecoverySurface{listed: names}, false); n.Type != recoveryNextManual {
		t.Fatalf("mcp = %+v", n)
	}
	cli := cliRecoverySurface{executable: "/opt/orbit", capabilities: []cliCapability{
		{ID: "session_get", Argv: []string{"/opt/orbit", "session", "get"}, Available: false},
	}}
	if n := renderRecoveryNext(env, cli, false); n.Type != recoveryNextManual {
		t.Fatalf("cli unavailable = %+v", n)
	}
	cli.capabilities[0].Available = true
	if n := renderRecoveryNext(env, cli, false); n.Type != recoveryNextInvoke || !reflect.DeepEqual(n.Argv, []string{"/opt/orbit", "session", "get", "S9", "--json"}) {
		t.Fatalf("cli available = %+v", n)
	}
	// An id that could be read as a flag or a path is never handed on.
	env.Resources = []recoveryResource{{Type: "SESSION", ID: "--all"}, {Type: "SESSION", ID: "../x"}}
	if n := renderRecoveryNext(env, cli, false); n.Type != recoveryNextManual {
		t.Fatalf("unsafe id = %+v", n)
	}
	// A command this process does not advertise is not offered again.
	retry := "RETRY"
	env = recoveryEnvelope{ActionCode: &retry, Effect: "NONE", UserConfirmation: "NOT_REQUIRED"}
	cli = cliRecoverySurface{executable: "/opt/orbit", argv: []string{"login"}, replayStdin: true}
	if n := renderRecoveryNext(env, cli, false); n.Type != recoveryNextManual {
		t.Fatalf("unadvertised retry = %+v", n)
	}
}

// A write that went through earlier in the same call leaves the call as a whole not untouched: a later
// refusal that wrote nothing by itself is reported UNKNOWN and verified first, never resent.
func TestRecoveryAWriteEarlierInTheCallIsNotReportedAsNone(t *testing.T) {
	mark := markTransportActivity()
	noteTransportAttempt()
	noteTransportResult(http.MethodPost, nil)
	noteTransportAttempt()
	failure := &transportHTTPError{method: "GET", path: "/runner/x", statusCode: 503,
		body: `{"code":"TRANSIENT_DB_CONFLICT","message":"m","retryable":true}`}
	noteTransportResult(http.MethodGet, failure)
	env := recoveryForFailure(nil, "wait failed: "+failure.Error(), mark, false)
	if env.Code != "TRANSIENT_DB_CONFLICT" || env.Effect != "UNKNOWN" || env.Retry.Policy != "VERIFY_THEN_RETRY" ||
		env.ActionCode == nil || *env.ActionCode != "VERIFY_STATE" {
		t.Fatalf("env = %+v", env)
	}
}

func TestRecoverySuccessfulToolResultIsUntouched(t *testing.T) {
	ok := toolResult("fine", false)
	if got := (&mcpServer{}).withRecovery("task_get", nil, markTransportActivity(), ok); !reflect.DeepEqual(got, toolResult("fine", false)) {
		t.Fatalf("success changed: %v", got)
	}
}

// Serialize the initialize/list/call sequence that an MCP client receives. Validate the
// actual structured error against the advertised schema with a standard JSON Schema engine.
func TestRecoverySerializedSchemaAndPreDispatchRefusals(t *testing.T) {
	recoveryRenderEnv(t, "http://127.0.0.1:1")
	s := &mcpServer{sessionID: "S1", onlyTools: map[string]bool{"wiki_search": true}}
	call := func(method string, params interface{}) map[string]interface{} {
		raw, _ := json.Marshal(params)
		response, _ := s.handle(&rpcRequest{JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: method, Params: raw})
		wire, err := json.Marshal(response)
		if err != nil {
			t.Fatal(err)
		}
		var decoded struct {
			Result map[string]interface{} `json:"result"`
		}
		if err := json.Unmarshal(wire, &decoded); err != nil {
			t.Fatal(err)
		}
		return decoded.Result
	}
	call("initialize", map[string]interface{}{"protocolVersion": "2025-06-18"})
	listed := call("tools/list", nil)
	tools := listed["tools"].([]interface{})
	var schema interface{}
	for _, item := range tools {
		tool := item.(map[string]interface{})
		if tool["name"] == "wiki_search" {
			schema = tool["outputSchema"]
		}
	}
	if schema == nil {
		t.Fatal("schema-declared tool missing")
	}
	var validation []map[string]interface{}
	for _, name := range []string{"wiki_search", "task_get"} {
		result := call("tools/call", map[string]interface{}{"name": name, "arguments": map[string]interface{}{}})
		if result["isError"] != true {
			t.Fatalf("%s did not fail: %#v", name, result)
		}
		content := result["content"].([]interface{})
		if len(content) != 1 {
			t.Fatalf("legacy content changed: %#v", content)
		}
		text := content[0].(map[string]interface{})["text"].(string)
		if name == "task_get" && text != "task_get is not served in this session" {
			t.Fatalf("legacy refusal changed: %q", text)
		}
		report := decodeMCPReport(t, result)
		if report.Error.Code != recoveryLocalRefusedCode || report.Error.Effect != "NONE" || report.Next.Type == recoveryNextInvoke {
			t.Fatalf("invalid refusal: %#v", report)
		}
		validation = append(validation, map[string]interface{}{"schema": schema, "result": result["structuredContent"]})
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("schema validation requires Node.js and Ajv")
	}
	script := `let Ajv; try { Ajv=require('ajv') } catch { Ajv=require('/usr/share/nodejs/ajv') }
 const fs=require('fs'); const ajv=new Ajv({strict:false});
 for(const v of JSON.parse(fs.readFileSync(0,'utf8'))) {
  const validate=ajv.compile(v.schema);
  if(!validate(v.result)) throw Error(JSON.stringify(validate.errors));
 }
 console.log('Serialized MCP recovery results match advertised outputSchema');`
	probe := exec.Command(node, "-e", `try { require('ajv') } catch { require('/usr/share/nodejs/ajv') }`)
	if err := probe.Run(); err != nil {
		t.Skip("Ajv is unavailable; MCP envelope assertions passed")
	}
	command := exec.Command(node, "-e", script)
	raw, _ := json.Marshal(validation)
	command.Stdin = bytes.NewReader(raw)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("schema rejected recovery: %v: %s", err, output)
	}
	t.Log(strings.TrimSpace(string(output)))
}

func TestRecoveryCLIChild(t *testing.T) {
	if os.Getenv("ORBIT_TEST_RECOVERY_ARGS") == "" {
		return
	}
	var args []string
	if err := json.Unmarshal([]byte(os.Getenv("ORBIT_TEST_RECOVERY_ARGS")), &args); err != nil {
		panic(err)
	}
	os.Args = append([]string{"orbit"}, args...)
	main()
	os.Exit(0)
}

func recoveryCLIProcess(t *testing.T, args []string, extraEnv ...string) (string, string, error) {
	t.Helper()
	command := exec.Command(reachableTestBinary(t), "-test.run=^TestRecoveryCLIChild$")
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "ORBIT_") {
			command.Env = append(command.Env, kv)
		}
	}
	raw, _ := json.Marshal(args)
	command.Env = append(command.Env, "ORBIT_HOME="+os.Getenv("ORBIT_HOME"), "ORBIT_TEST_RECOVERY_ARGS="+string(raw))
	command.Env = append(command.Env, extraEnv...)
	var out, errOut bytes.Buffer
	command.Stdout = &out
	command.Stderr = &errOut
	err := command.Run()
	return out.String(), errOut.String(), err
}

func TestRecoveryCLIAllDiscardsPagesOnFailure(t *testing.T) {
	body := `{"code":"PAGE_REFUSED","message":"Read the project","recovery":{"effect":"NONE","retryPolicy":"VERIFY_THEN_RETRY","actionCode":"VERIFY_STATE","actor":"CALLER","resources":[{"type":"PROJECT","id":"P1"}]}}`
	var fail atomic.Bool
	fail.Store(true)
	var pages atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/projects/") {
			w.WriteHeader(409)
			_, _ = io.WriteString(w, body)
			return
		}
		pages.Add(1)
		if r.URL.Query().Get("cursor") == "c2" {
			if fail.Load() {
				w.WriteHeader(409)
				_, _ = io.WriteString(w, body)
			} else {
				_, _ = io.WriteString(w, `{"items":[{"id":"t2"}],"nextCursor":null}`)
			}
			return
		}
		_, _ = io.WriteString(w, `{"items":[{"id":"t1"}],"nextCursor":"c2"}`)
	}))
	defer srv.Close()
	recoveryRenderEnv(t, srv.URL)
	out, _, err := recoveryCLIProcess(t, []string{"task", "list", "--all", "--json"})
	if err == nil || pages.Load() != 2 {
		t.Fatalf("expected second-page process failure: %v, pages=%d, out=%s", err, pages.Load(), out)
	}
	report := decodeCLIReport(t, out)
	s := &mcpServer{t: NewTransport(srv.URL, "tok")}
	mcp := decodeMCPReport(t, s.callTool("project_get", map[string]interface{}{"projectId": "P1"}))
	// The same failed-page fixture over MCP, without replaying the earlier page.
	expected, _ := parseRecovery(recoveryObservation{Source: "HTTP", Status: 409, Body: body})
	if !reflect.DeepEqual(report.Error, expected) {
		t.Fatalf("page error contract changed: %#v / %#v", report.Error, expected)
	}
	if report.Next.Type != recoveryNextInvoke || !filepath.IsAbs(report.Next.Argv[0]) {
		t.Fatalf("missing safe read: %#v", report.Next)
	}
	if !reflect.DeepEqual(mcp.Error, report.Error) || !reflect.DeepEqual(comparableNext(mcp.Next), comparableNext(report.Next)) {
		t.Fatalf("partial-page parity: %#v / %#v", mcp, report)
	}
	fail.Store(false)
	out, stderr, err := recoveryCLIProcess(t, []string{"task", "list", "--all", "--json"})
	if err != nil || stderr != "" || out != "{\"id\":\"t1\"}\n{\"id\":\"t2\"}\n" {
		t.Fatalf("successful NDJSON changed: %v %q %q", err, out, stderr)
	}
}

func TestRecoveryCLIJSONFailuresAcrossFamilies(t *testing.T) {
	recoveryRenderEnv(t, "http://127.0.0.1:1")
	for _, args := range [][]string{
		{"task", "get", "--invalid", "--json"}, {"project", "get", "--invalid", "--json"},
		{"session", "get", "--invalid", "--json"}, {"agent", "list", "--invalid", "--json"},
		{"runner", "list", "--invalid", "--json"}, {"provider", "list", "--invalid", "--json"},
		{"notify", "--invalid", "--json"}, {"watch", "create", "--invalid", "--json"},
		{"wiki", "search", "--invalid", "--json"}, {"file", "fetch", "--invalid", "--json"},
		{"token", "list", "--invalid", "--json"}, {"whoami", "--invalid", "--json"},
		{"api", "--invalid", "--json"}, {"capabilities", "--invalid", "--json"},
	} {
		t.Run(strings.Join(args[:2], "_"), func(t *testing.T) {
			out, _, err := recoveryCLIProcess(t, args)
			if err == nil {
				t.Fatalf("expected nonzero exit: %s", out)
			}
			if report := decodeCLIReport(t, out); report.OK || report.Error.Code == "" {
				t.Fatalf("missing envelope: %#v", report)
			}
		})
	}
}

func TestRecoveryCLIAPIDiscardsBodyAndPagesOnFailure(t *testing.T) {
	body := `{"code":"API_REFUSED","message":"Fix the request","recovery":{"effect":"NONE","retryPolicy":"NEVER","actionCode":"FIX_REQUEST"}}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("cursor") == "c2" {
			w.WriteHeader(409)
			_, _ = io.WriteString(w, body)
			return
		}
		_, _ = io.WriteString(w, `{"items":[{"id":"t1"}],"nextCursor":"c2"}`)
	}))
	defer srv.Close()
	recoveryRenderEnv(t, srv.URL)
	out, _, err := recoveryCLIProcess(t, []string{"api", "/api/tasks/page", "--paginate", "--json"}, envUserToken+"="+userTokenPrefix+"test", envUserServerURL+"="+srv.URL)
	if err == nil {
		t.Fatalf("expected nonzero exit: %s", out)
	}
	report := decodeCLIReport(t, out)
	expected, _ := parseRecovery(recoveryObservation{Source: "HTTP", Status: 409, Body: body})
	if !reflect.DeepEqual(report.Error, expected) {
		t.Fatalf("API failure fields lost: %#v / %#v", report.Error, expected)
	}
}

func TestRecoveryCLIWhoamiDiscardsIdentityOnFailure(t *testing.T) {
	recoveryRenderEnv(t, "http://127.0.0.1:1")
	out, _, err := recoveryCLIProcess(t, []string{"whoami", "--json"}, envUserToken+"="+userTokenPrefix+"test", envUserServerURL+"=http://127.0.0.1:1")
	if err == nil {
		t.Fatalf("expected nonzero exit: %s", out)
	}
	report := decodeCLIReport(t, out)
	if report.Error.Effect != "UNKNOWN" || report.Error.Code != "TRANSPORT_NO_ANSWER" {
		t.Fatalf("no-answer contract changed: %#v", report)
	}
}

func TestRecoveryCLIStringValuesNeverBecomeFlags(t *testing.T) {
	body := `{"code":"WRITE_UNKNOWN","message":"Check state","recovery":{"effect":"UNKNOWN","retryPolicy":"SAME_REQUEST_ID"}}`
	messages := make(chan string, 32)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var sent map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&sent)
		messages <- sent["message"].(string)
		for _, pair := range recoveryRequestIDArgs {
			if sent[pair[0]] != nil {
				t.Errorf("user text became an outbound ID: %#v", sent)
			}
		}
		w.WriteHeader(409)
		_, _ = io.WriteString(w, body)
	}))
	defer server.Close()
	recoveryRenderEnv(t, server.URL)
	for _, value := range []string{"--json", "--json=true", "--client-turn-id=x", "--trigger-id=x", "--idempotency-key=x"} {
		t.Run(value, func(t *testing.T) {
			out, stderr, err := recoveryCLIProcess(t, []string{"notify", "--message", value})
			if err == nil || out != "" || !strings.HasPrefix(stderr, "orbit notify: notify:") {
				t.Fatalf("literal changed human mode: %v, stdout=%q stderr=%q", err, out, stderr)
			}
			if got := <-messages; got != value {
				t.Fatalf("message=%q, want %q", got, value)
			}
			out, _, err = recoveryCLIProcess(t, []string{"notify", "--message", value, "--json"})
			if err == nil {
				t.Fatal("expected failure")
			}
			report := decodeCLIReport(t, out)
			if report.Error.Retry.Policy != "VERIFY_THEN_RETRY" || report.Next.Type == recoveryNextInvoke {
				t.Fatalf("keyless write can replay: %#v", report)
			}
			if got := <-messages; got != value {
				t.Fatalf("message=%q, want %q", got, value)
			}
		})
	}
}

func TestRecoveryCLIJSONUsesGoBooleanFormsAndLastValue(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(409)
		_, _ = io.WriteString(w, `{"code":"REFUSED","message":"Stop"}`)
	}))
	defer server.Close()
	recoveryRenderEnv(t, server.URL)
	for _, value := range []string{"1", "t", "T", "TRUE", "true", "True", "0", "f", "F", "FALSE", "false", "False"} {
		t.Run(value, func(t *testing.T) {
			out, stderr, err := recoveryCLIProcess(t, []string{"notify", "--message", "text", "--json=true", "--json=" + value})
			if err == nil {
				t.Fatal("expected failure")
			}
			enabled, _ := strconv.ParseBool(value)
			if enabled {
				decodeCLIReport(t, out)
			} else if out != "" || !strings.HasPrefix(stderr, "orbit notify:") {
				t.Fatalf("false JSON value changed human mode: %q %q", out, stderr)
			}
		})
	}
}

func TestRecoveryCLIOnlyActualNonemptyIDsProtectTheWrite(t *testing.T) {
	sentIDs := make(chan map[string]interface{}, 16)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var sent map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&sent)
		sentIDs <- sent
		w.WriteHeader(409)
		_, _ = io.WriteString(w, `{"code":"WRITE_UNKNOWN","message":"Read first","recovery":{"effect":"UNKNOWN","retryPolicy":"SAME_REQUEST_ID"}}`)
	}))
	defer server.Close()
	recoveryRenderEnv(t, server.URL)
	for _, test := range []struct {
		name      string
		args      []string
		protected bool
	}{
		{"literal", []string{"session", "send", "S1", "--message", "--client-turn-id=x", "--json"}, false},
		{"empty", []string{"session", "send", "S1", "--message", "text", "--client-turn-id=", "--json"}, false},
		{"whitespace", []string{"session", "send", "S1", "--message", "text", "--client-turn-id= ", "--json"}, false},
		{"explicit", []string{"session", "send", "S1", "--message", "text", "--client-turn-id=x", "--json"}, true},
		{"separate", []string{"session", "send", "S1", "--message", "text", "--client-turn-id", "x", "--json"}, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			out, _, err := recoveryCLIProcess(t, test.args)
			if err == nil {
				t.Fatal("expected failure")
			}
			report := decodeCLIReport(t, out)
			sent := <-sentIDs
			if test.protected {
				if sent["clientTurnId"] != "x" || report.Error.Retry.Policy != "SAME_REQUEST_ID" || report.Next.Type != recoveryNextInvoke {
					t.Fatalf("same-ID recovery missing: sent=%#v report=%#v", sent, report)
				}
				if !reflect.DeepEqual(report.Next.Argv[1:], test.args) {
					t.Fatalf("retry changed ID: %#v", report.Next)
				}
			} else if sent["clientTurnId"] != nil || report.Error.Retry.Policy != "VERIFY_THEN_RETRY" || report.Next.Type == recoveryNextInvoke {
				t.Fatalf("keyless replay: sent=%#v report=%#v", sent, report)
			}
		})
	}
	// task start generates its trigger after flag parsing. The envelope must see that
	// actual ID, but the CLI cannot replay argv that would generate a different trigger.
	out, _, err := recoveryCLIProcess(t, []string{"task", "start", "T1", "--json"})
	if err == nil {
		t.Fatal("expected failure")
	}
	report := decodeCLIReport(t, out)
	sent := <-sentIDs
	if trigger, ok := sent["triggerId"].(string); !ok || trigger == "" || report.Error.Retry.Policy != "SAME_REQUEST_ID" || report.Next.Type == recoveryNextInvoke {
		t.Fatalf("generated ID recovery unsafe: sent=%#v report=%#v", sent, report)
	}
	mcp := &mcpServer{t: NewTransport(server.URL, "tok")}
	mcpReport := decodeMCPReport(t, mcp.callTool("task_start", map[string]interface{}{"taskId": "T1"}))
	<-sentIDs
	if !reflect.DeepEqual(mcpReport.Error, report.Error) || !reflect.DeepEqual(comparableNext(mcpReport.Next), comparableNext(report.Next)) {
		t.Fatalf("generated ID differs across surfaces: %#v / %#v", mcpReport, report)
	}
}

func TestRecoveryOutboundIDsIgnoreEmptyValues(t *testing.T) {
	for _, pair := range recoveryRequestIDArgs {
		for _, value := range []string{"", " ", "x"} {
			got := outboundRecoveryIDs([]interface{}{map[string]interface{}{pair[0]: value}})
			if (len(got) > 0) != (value == "x") {
				t.Fatalf("outbound ID %s=%q: %#v", pair[0], value, got)
			}
		}
	}
}

// Recovery's boundary grammar must stay consistent with actual typed registrations.
// A missing value-taking option could otherwise let its user text masquerade as --json.
func TestRecoveryCLIGrammarMatchesTypedFlagRegistrations(t *testing.T) {
	paths, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	literal := func(expr ast.Expr) string {
		if value, ok := expr.(*ast.BasicLit); ok && value.Kind == token.STRING {
			s, _ := strconv.Unquote(value.Value)
			return s
		}
		return ""
	}
	for _, path := range paths {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			command := ""
			needsJSON := false
			peeled := 0
			ast.Inspect(fn.Body, func(node ast.Node) bool {
				call, ok := node.(*ast.CallExpr)
				if !ok {
					return true
				}
				if method, ok := call.Fun.(*ast.SelectorExpr); ok && method.Sel.Name == "Bool" && len(call.Args) > 0 && literal(call.Args[0]) == "json" {
					needsJSON = true
				}
				if name, ok := call.Fun.(*ast.Ident); ok && name.Name == "peelLeadingID" {
					peeled++
				}
				if name, ok := call.Fun.(*ast.Ident); ok && name.Name == "peelLeadingPositionals" {
					peeled = -1
				}
				if name, ok := call.Fun.(*ast.Ident); ok && name.Name == "newCLIFlagSet" && len(call.Args) == 1 {
					command = strings.TrimPrefix(literal(call.Args[0]), "orbit ")
				}
				return true
			})
			if command == "" {
				continue
			}
			options, _, positionals := recoveryCLIOptions(strings.Fields(command))
			if !needsJSON {
				continue
			}
			if _, ok := options["json"]; !ok {
				t.Errorf("%s: JSON command has no recovery grammar", command)
				continue
			}
			if positionals != peeled {
				t.Errorf("%s: recovery positionals=%d, actual leading ID peels=%d", command, positionals, peeled)
			}
			ast.Inspect(fn.Body, func(node ast.Node) bool {
				call, ok := node.(*ast.CallExpr)
				if !ok {
					return true
				}
				method, ok := call.Fun.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				receiver, ok := method.X.(*ast.Ident)
				if !ok || receiver.Name != "fs" {
					return true
				}
				index := 0
				switch method.Sel.Name {
				case "Bool", "String", "Int", "Int64", "Uint", "Duration":
				case "Var":
					index = 1
				default:
					return true
				}
				if len(call.Args) <= index {
					return true
				}
				name := literal(call.Args[index])
				if name == "" {
					return true
				}
				boolean, known := options[name]
				if !known || boolean != (method.Sel.Name == "Bool") {
					t.Errorf("%s --%s: recovery type (boolean=%v, known=%v) differs from fs.%s", command, name, boolean, known, method.Sel.Name)
				}
				return true
			})
		}
	}
}

func TestRecoveryCLIExplicitIdempotencyKey(t *testing.T) {
	sentIDs := make(chan interface{}, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		sentIDs <- body["idempotencyKey"]
		w.WriteHeader(409)
		_, _ = io.WriteString(w, `{"code":"WRITE_UNKNOWN","message":"Check state","recovery":{"effect":"UNKNOWN","retryPolicy":"SAME_REQUEST_ID"}}`)
	}))
	defer server.Close()
	recoveryRenderEnv(t, server.URL)
	for _, key := range []string{"", "x"} {
		out, _, err := recoveryCLIProcess(t, []string{"task", "evidence-submit", "T1", "--evidence", "{}", "--source-session-id", "S1", "--idempotency-key=" + key, "--json"})
		if err == nil {
			t.Fatal("expected failure")
		}
		report := decodeCLIReport(t, out)
		sent := <-sentIDs
		if key == "" {
			if sent != nil || report.Next.Type == recoveryNextInvoke || report.Error.Retry.Policy != "VERIFY_THEN_RETRY" {
				t.Fatalf("empty key protects write: %#v", report)
			}
		} else if sent != "x" || report.Next.Type != recoveryNextInvoke || report.Error.Retry.Policy != "SAME_REQUEST_ID" {
			t.Fatalf("real key missing: %#v", report)
		}
	}
}

func TestRecoveryCLIJSONAfterAllLeadingPositionals(t *testing.T) {
	for _, group := range recoveryCLISpecGroups() {
		for _, spec := range group {
			argv := append([]string{}, spec.Argv[1:]...)
			hasJSON := false
			for _, arg := range spec.Arguments {
				if strings.HasPrefix(arg, "[") {
					argv = append(argv, "ID")
				}
				if arg == "--json" {
					hasJSON = true
				}
			}
			if !hasJSON {
				continue
			}
			if spec.Tool == "wiki_search" || spec.Tool == "wiki_get" || spec.Tool == "wiki_note" {
				argv = append(argv, "second", "third")
			}
			argv = append(argv, "--json")
			if !cliJSONRequested(argv) {
				t.Errorf("%s: JSON unreachable after complete leading positionals: %v", spec.Tool, argv)
			}
		}
	}
}

func TestRecoveryCLITwoPositionalsFailure(t *testing.T) {
	recoveryRenderEnv(t, "http://127.0.0.1:1")
	out, stderr, err := recoveryCLIProcess(t, []string{"project", "skip-merge-check", "P1", "T1", "--reason", "test", "--json"})
	if err == nil || stderr != "" {
		t.Fatalf("expected JSON-only nonzero failure: %v %q %q", err, out, stderr)
	}
	if report := decodeCLIReport(t, out); report.OK || report.Error.Code == "" {
		t.Fatalf("missing recovery: %#v", report)
	}
}
