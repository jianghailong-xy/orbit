package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

// The guide (agent_guide.go) is the catalogue arranged by what a person asks for. These tests hold its
// routes and objects to the contract, every step to the catalogue, and its two doors to one document; and
// they check that it is there, read-only, in every session, so an agent missing a tool can learn why.

func TestGuideRoutesAreTheContractsRoutes(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "contracts", "orbit-agent.contract.json"))
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Objects []struct {
			ID       string `json:"id"`
			Question string `json:"question"`
		} `json:"objects"`
		IntentRoutes []struct {
			ID     string  `json:"id"`
			Object *string `json:"object"`
			MCP    *string `json:"mcp"`
		} `json:"intentRoutes"`
		RoutingRules []struct {
			ID   string `json:"id"`
			Rule string `json:"rule"`
		} `json:"routingRules"`
	}
	if err := json.Unmarshal(raw, &contract); err != nil {
		t.Fatal(err)
	}
	if len(contract.Objects) != len(guideObjects) {
		t.Fatalf("the contract has %d objects, the guide %d", len(contract.Objects), len(guideObjects))
	}
	for i, object := range contract.Objects {
		if guideObjects[i].ID != object.ID || guideObjects[i].Question != object.Question {
			t.Errorf("guide object %d = %+v, the contract's is %+v", i, guideObjects[i], object)
		}
	}
	if len(contract.IntentRoutes) != len(guideRoutes) {
		t.Fatalf("the contract has %d intent routes, the guide %d", len(contract.IntentRoutes), len(guideRoutes))
	}
	tool := regexp.MustCompile(`\b[a-z]+(?:_[a-z]+)+\b`)
	built := operationCatalog()
	answer, err := guideAnswer(guideFacts{context: guideContext{Surface: "mcp", Orchestration: true, Watches: true, Wiki: true}}, "")
	if err != nil {
		t.Fatal(err)
	}
	index := answer.(guideIndexDocument)
	for i, route := range contract.IntentRoutes {
		got := guideRoutes[i]
		if got.Route != route.ID {
			t.Errorf("guide route %d is %s, the contract's is %s", i, got.Route, route.ID)
			continue
		}
		object := "none"
		if route.Object != nil {
			object = *route.Object
		}
		if got.Object != object {
			t.Errorf("%s: the guide routes to %q, the contract to %q", route.ID, got.Object, object)
		}
		if route.MCP == nil {
			if len(got.Ops) != 0 || got.Topic != "" {
				t.Errorf("%s answers nothing in the contract, and the guide routes it to %v", route.ID, got.Ops)
			}
			continue
		}
		// Every catalogued tool the contract names for the route is one the guide names for it.
		for _, name := range tool.FindAllString(*route.MCP, -1) {
			if built.ByTool[name] == nil {
				continue
			}
			if !containsOp(got.Ops, name) {
				t.Errorf("%s: the contract routes to %s and the guide does not (%v)", route.ID, name, got.Ops)
			}
		}
		if guideTopicByID(got.Topic) == nil {
			t.Errorf("%s routes to topic %q, which the guide does not have", route.ID, got.Topic)
		}
		// The route says whether it writes and who must approve: its first operation's.
		first := built.ByTool[got.Ops[0]]
		for _, view := range index.Routes {
			if view.Route == got.Route && (view.Mutates != first.Mutates || view.Approval != first.Approval) {
				t.Errorf("%s says mutates=%v approval=%q, its first operation %s says %v %q", got.Route,
					view.Mutates, view.Approval, first.Tool, first.Mutates, first.Approval)
			}
		}
	}
	if len(contract.RoutingRules) != len(guideRules) {
		t.Fatalf("the contract has %d routing rules, the guide %d", len(contract.RoutingRules), len(guideRules))
	}
	for i, rule := range contract.RoutingRules {
		if want := rule.ID + ": " + rule.Rule; guideRules[i] != want {
			t.Errorf("guide rule %d = %q, the contract's is %q", i, guideRules[i], want)
		}
	}
}

// Every step, route and related topic names something that exists, and every topic says what it is for
// and what proves it done.
func TestEveryGuideStepIsACatalogOperation(t *testing.T) {
	built := operationCatalog()
	seen := map[string]bool{}
	for _, topic := range guideTopics {
		if seen[topic.ID] {
			t.Errorf("topic %s is declared twice", topic.ID)
		}
		seen[topic.ID] = true
		if strings.TrimSpace(topic.Intent) == "" || strings.TrimSpace(topic.Done) == "" || len(topic.Rules) == 0 || len(topic.Steps) == 0 {
			t.Errorf("topic %s does not say what it is for, its steps, its rules and what proves it done", topic.ID)
		}
		required := 0
		for _, step := range topic.Steps {
			op := built.ByTool[step.Op]
			if op == nil {
				t.Errorf("topic %s names %s, which the catalogue does not declare", topic.ID, step.Op)
				continue
			}
			if op.Gate == gatePermissionPrompt {
				t.Errorf("topic %s sends an agent to %s, the engine's own bridge", topic.ID, step.Op)
			}
			if strings.TrimSpace(step.Why) == "" {
				t.Errorf("topic %s step %s does not say why it is there", topic.ID, step.Op)
			}
			if !step.Optional {
				required++
			}
		}
		if required == 0 {
			t.Errorf("topic %s has no step that is not optional", topic.ID)
		}
		for _, related := range topic.Related {
			if guideTopicByID(related) == nil {
				t.Errorf("topic %s relates to %q, which is not a topic", topic.ID, related)
			}
		}
	}
	for _, route := range guideRoutes {
		for _, op := range route.Ops {
			if built.ByTool[op] == nil {
				t.Errorf("route %s names %s, which the catalogue does not declare", route.Route, op)
			}
		}
	}
	enum := mcpToolProps(toolDescriptors(false, false), "guide")["topic"].(map[string]interface{})["enum"]
	if !reflect.DeepEqual(enum, guideTopicIDs()) {
		t.Errorf("the guide tool's topic enum %v is not the guide's topics %v", enum, guideTopicIDs())
	}
}

// The guide is listed in every session, whatever its switches, and says of itself that it only reads.
func TestGuideToolIsAlwaysListedAndReadOnly(t *testing.T) {
	op := catalogOperation("guide")
	if op == nil || op.MCP == nil || op.CLI == nil {
		t.Fatal("the guide is not an operation with both doors")
	}
	if op.Mutates || op.Gate != gateAlways || op.Approval != approvalKindNone || op.Risk != riskLow ||
		op.Idempotency != idempotencyRead || op.Object != objectCatalog {
		t.Errorf("the guide is not an always-listed read: %+v", op)
	}
	if annotations, _ := op.MCP.Extra["annotations"].(map[string]interface{}); annotations["readOnlyHint"] != true {
		t.Errorf("the guide does not declare itself read-only to the client: %v", op.MCP.Extra)
	}
	for _, permissionPrompt := range []bool{false, true} {
		for _, orchestration := range []bool{false, true} {
			tools := toolDescriptors(permissionPrompt, orchestration)
			for _, listed := range [][]map[string]interface{}{tools, withoutWatchTools(withoutWikiTools(tools))} {
				if mcpToolDescription(listed, "guide") == "" {
					t.Errorf("guide is missing from tools/list (permissionPrompt=%v, orchestration=%v)", permissionPrompt, orchestration)
				}
			}
		}
	}
	for _, c := range discoveryContexts {
		enterDiscoveryContext(t, c)
		found := false
		for _, capability := range buildCLICapabilities("/opt/orbit").Capabilities {
			if capability.ID == "guide" {
				found = capability.Available
			}
		}
		if !found {
			t.Errorf("orbit guide is not offered in the %s context", c.name)
		}
	}
}

// The two doors answer one document: the MCP tool's structured content and `orbit guide --json` differ
// only in which surface answered.
func TestGuideAnswersTheSameDocumentOnBothDoors(t *testing.T) {
	catalogFullestCLIContext(t)
	t.Setenv("ORBIT_TASK_ID", "catalog-test-task")
	srv := &mcpServer{sessionID: "catalog-test-session", agentID: "catalog-test-agent", taskID: "catalog-test-task", allowOrchestration: true}
	for _, topic := range append([]string{""}, guideTopicIDs()...) {
		args := map[string]interface{}{}
		cliArgs := []string{"guide", "--json"}
		if topic != "" {
			args["topic"] = topic
			cliArgs = []string{"guide", topic, "--json"}
		}
		result := srv.invokeTool("guide", args)
		if result["isError"] == true {
			t.Fatalf("MCP guide %q: %s", topic, mcpResultText(result))
		}
		viaMCP, _ := result["structuredContent"].(map[string]interface{})
		var text map[string]interface{}
		if err := json.Unmarshal([]byte(mcpResultText(result)), &text); err != nil || !reflect.DeepEqual(text, viaMCP) {
			t.Fatalf("MCP guide %q: the text is not the structured content: %v", topic, err)
		}
		var out, errOut bytes.Buffer
		if err := runOrbitCLI(cliArgs, strings.NewReader(""), &out, &errOut); err != nil {
			t.Fatalf("orbit %s: %v", strings.Join(cliArgs, " "), err)
		}
		var viaCLI map[string]interface{}
		if err := json.Unmarshal(out.Bytes(), &viaCLI); err != nil {
			t.Fatal(err)
		}
		mcpContext, _ := viaMCP["context"].(map[string]interface{})
		cliContext, _ := viaCLI["context"].(map[string]interface{})
		if mcpContext["surface"] != "mcp" || cliContext["surface"] != "cli" {
			t.Errorf("guide %q: the doors do not say which answered: %v / %v", topic, mcpContext, cliContext)
		}
		for _, key := range []string{"actor", "sessionId", "agentId", "taskId", "orchestration", "watches", "wiki"} {
			if !reflect.DeepEqual(mcpContext[key], cliContext[key]) {
				t.Errorf("guide %q: context %s is %v over MCP and %v at the CLI", topic, key, mcpContext[key], cliContext[key])
			}
		}
		for _, key := range []string{"view", "guideVersion", "catalogVersion", "catalogHash", "objects", "routes", "rules", "topics", "topic", "intent", "done", "related"} {
			if !reflect.DeepEqual(viaMCP[key], viaCLI[key]) {
				t.Errorf("guide %q: %s differs between the doors", topic, key)
			}
		}
		mcpSteps, _ := viaMCP["steps"].([]interface{})
		cliSteps, _ := viaCLI["steps"].([]interface{})
		if len(mcpSteps) != len(cliSteps) {
			t.Fatalf("guide %q: %d steps over MCP, %d at the CLI", topic, len(mcpSteps), len(cliSteps))
		}
		for i := range mcpSteps {
			m, _ := mcpSteps[i].(map[string]interface{})
			c, _ := cliSteps[i].(map[string]interface{})
			if op := catalogOperation(fmt.Sprint(m["id"])); op == nil || m["planMode"] != string(op.Plan) {
				t.Errorf("guide %q step %d: planMode %v is not the catalogue's", topic, i+1, m["planMode"])
			}
			for _, key := range []string{"step", "id", "why", "optional", "mutates", "approval", "approvalKey", "planMode", "successEvidence", "mcp"} {
				if !reflect.DeepEqual(m[key], c[key]) {
					t.Errorf("guide %q step %d: %s differs between the doors: %v / %v", topic, i+1, key, m[key], c[key])
				}
			}
		}
	}
	if result := srv.invokeTool("guide", map[string]interface{}{"topic": "no-such-topic"}); result["isError"] != true {
		t.Errorf("an unknown topic was answered: %v", result)
	}
	if result := srv.invokeTool("guide", map[string]interface{}{"topik": "task-create"}); result["isError"] != true {
		t.Errorf("an unknown argument was answered: %v", result)
	}
}

// A step the session cannot take is answered with why, in the words the door itself would refuse with,
// while the guide itself keeps answering.
func TestGuideSaysWhyAStepIsUnavailable(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	srv := &mcpServer{sessionID: "s", agentID: "a", allowOrchestration: false, watchesOff: true, wikiOff: true}
	steps := func(topic string) map[string]guideStepView {
		doc, err := guideAnswer(srv.guideFacts(), topic)
		if err != nil {
			t.Fatal(err)
		}
		out := map[string]guideStepView{}
		for _, step := range doc.(guideTopicDocument).Steps {
			out[step.ID] = step
		}
		return out
	}
	for _, tc := range []struct {
		topic, step, want string
	}{
		{"delegate", "session_create", orchestrationOffMsg},
		{"agent", "agent_list", orchestrationOffMsg},
		{"wait", "task_await", "Watch is switched off for this session"},
		{"wiki", "wiki_search", "the Orbit wiki is switched off for this session"},
	} {
		step := steps(tc.topic)[tc.step]
		if step.MCP == nil || step.MCP.Available || !strings.Contains(step.MCP.UnavailableReason, tc.want) {
			t.Errorf("%s/%s: %+v, want it unavailable saying %q", tc.topic, tc.step, step.MCP, tc.want)
		}
	}
	if step := steps("task-create")["task_create"]; step.MCP == nil || !step.MCP.Available {
		t.Errorf("task_create is unavailable with orchestration off: %+v", step.MCP)
	}
	index, _ := guideAnswer(srv.guideFacts(), "")
	for _, route := range index.(guideIndexDocument).Routes {
		if route.Route == "R1.7" && (route.Available || route.UnavailableReason != orchestrationOffMsg) {
			t.Errorf("R1.7 (delegate) is offered with orchestration off: %+v", route)
		}
	}
	if result := srv.invokeTool("guide", map[string]interface{}{}); result["isError"] == true {
		t.Errorf("the guide does not answer in a session with every switch off: %s", mcpResultText(result))
	}
}
