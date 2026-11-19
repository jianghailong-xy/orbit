package main

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeWorkflowHost answers every call from answer, recording what the script asked.
type fakeWorkflowHost struct {
	mu     sync.Mutex
	calls  []workflowCall
	logs   []string
	answer func(c workflowCall) workflowCallResult
	block  chan struct{} // when set, every call waits for it (or ctx)
}

func (h *fakeWorkflowHost) runCall(ctx context.Context, c workflowCall) workflowCallResult {
	h.mu.Lock()
	h.calls = append(h.calls, c)
	h.mu.Unlock()
	if h.block != nil {
		select {
		case <-h.block:
		case <-ctx.Done():
			return workflowCallResult{Err: "stopped"}
		}
	}
	if h.answer != nil {
		return h.answer(c)
	}
	return workflowCallResult{OK: true, Result: "did: " + c.Prompt, CostUsd: 0.1}
}

func (h *fakeWorkflowHost) log(message string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.logs = append(h.logs, message)
}

const testMeta = "export const meta = { name: 'w', description: 'test', phases: [{ title: 'A' }, { title: 'B' }] }\n"

func runTestWorkflow(t *testing.T, body string, args interface{}, maxCost float64, host *fakeWorkflowHost) workflowOutcome {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return runWorkflowScript(ctx, testMeta+body, args, maxCost, host)
}

func TestParseWorkflowMeta(t *testing.T) {
	meta, err := parseWorkflowMeta("// a review\n/* block */\n" + `export const meta = {
  name: 'review-changes', description: "Review { the } diff",
  phases: [{ title: 'Review', detail: 'a } b' }, { title: 'Verify' }],
} // trailing
const x = 1`)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Name != "review-changes" || meta.Description != "Review { the } diff" || strings.Join(meta.Phases, ",") != "Review,Verify" {
		t.Fatalf("meta = %+v", meta)
	}
	for _, bad := range []string{
		"const meta = { name: 'a', description: 'b' }",
		"await agent('x')\nexport const meta = { name: 'a', description: 'b' }",
		"export const meta = { name: 'a' }",
		"export const meta = { name: 'a', description: 'b'",
		"export const meta = { name: missing, description: 'b' }",
	} {
		if _, err := parseWorkflowMeta(bad); err == nil {
			t.Errorf("parseWorkflowMeta(%q) accepted it", bad)
		}
	}
}

func TestWorkflowPipelineAndParallel(t *testing.T) {
	host := &fakeWorkflowHost{}
	out := runTestWorkflow(t, `
phase('A')
const reviewed = await pipeline(args.items,
  (item) => agent('review ' + item, { label: 'review:' + item }),
  (prev, item, i) => prev + ' #' + i)
const checked = await parallel(reviewed.map((r) => () => agent('check ' + r, { phase: 'B', type: 'explore' })))
log('checked ' + checked.length)
return { reviewed, checked }
`, map[string]interface{}{"items": []interface{}{"x", "y"}}, 0, host)
	if out.Err != "" {
		t.Fatal(out.Err)
	}
	var got struct{ Reviewed, Checked []string }
	if err := json.Unmarshal([]byte(out.Result), &got); err != nil {
		t.Fatalf("result %q: %v", out.Result, err)
	}
	if strings.Join(got.Reviewed, "|") != "did: review x #0|did: review y #1" {
		t.Fatalf("reviewed = %v", got.Reviewed)
	}
	if len(got.Checked) != 2 || !strings.HasPrefix(got.Checked[0], "did: check did: review x") {
		t.Fatalf("checked = %v", got.Checked)
	}
	if out.CallsDone != 4 || out.CallsFailed != 0 || out.SpentUsd < 0.39 || out.SpentUsd > 0.41 {
		t.Fatalf("outcome = %+v", out)
	}
	byPrompt := map[string]workflowCall{}
	indexes := map[int]bool{}
	for _, c := range host.calls {
		byPrompt[strings.Fields(c.Prompt)[0]+strings.Fields(c.Prompt)[1]] = c
		indexes[c.Index] = true
	}
	if c := byPrompt["reviewx"]; c.Phase != "A" || c.Label != "review:x" {
		t.Fatalf("review call = %+v", c)
	}
	if c := byPrompt["checkdid:"]; c.Phase != "B" || c.Type != "explore" {
		t.Fatalf("check call = %+v", c)
	}
	if len(indexes) != 4 || !indexes[0] || !indexes[3] {
		t.Fatalf("call indexes = %v", indexes)
	}
	if len(host.logs) != 1 || host.logs[0] != "checked 2" {
		t.Fatalf("logs = %v", host.logs)
	}
}

func TestWorkflowFailedCallIsNull(t *testing.T) {
	host := &fakeWorkflowHost{answer: func(c workflowCall) workflowCallResult {
		if c.Prompt == "bad" {
			return workflowCallResult{Err: "no provider", CostUsd: 0.05}
		}
		return workflowCallResult{OK: true, Result: "ok"}
	}}
	out := runTestWorkflow(t, `return await parallel([() => agent('bad'), () => agent('good'), () => { throw new Error('boom') }])`, nil, 0, host)
	if out.Err != "" || out.Result != `[null,"ok",null]` || out.CallsDone != 1 || out.CallsFailed != 1 || out.SpentUsd != 0.05 {
		t.Fatalf("outcome = %+v", out)
	}
}

func TestWorkflowBudget(t *testing.T) {
	host := &fakeWorkflowHost{answer: func(workflowCall) workflowCallResult { return workflowCallResult{OK: true, Result: "r", CostUsd: 0.6} }}
	out := runTestWorkflow(t, `
const got = []
try {
  for (let i = 0; i < 5; i++) got.push(await agent('step ' + i))
} catch (e) {
  return { got: got.length, error: e.name, remaining: budget.remainingUsd(), max: budget.maxCostUsd }
}
`, nil, 1.0, host)
	if out.Err != "" || out.Result != `{"got":2,"error":"WorkflowBudgetSpent","remaining":0,"max":1}` {
		t.Fatalf("outcome = %+v", out)
	}
	unlimited := runTestWorkflow(t, `return [budget.maxCostUsd, budget.remainingUsd() === Infinity]`, nil, 0, &fakeWorkflowHost{})
	if unlimited.Result != `[null,true]` {
		t.Fatalf("no limit: %+v", unlimited)
	}
}

func TestWorkflowRefusals(t *testing.T) {
	for name, tc := range map[string]struct{ body, want string }{
		"date now":    {`return Date.now()`, "Date.now() is not available"},
		"random":      {`return Math.random()`, "Math.random() is not available"},
		"bare date":   {`return new Date()`, "new Date() without arguments"},
		"schema":      {`return await agent('x', { schema: {} })`, "schema is not supported yet"},
		"isolation":   {`return await agent('x', { isolation: 'worktree' })`, "isolation is not supported yet"},
		"unknown opt": {`return await agent('x', { colour: 1 })`, "unknown option colour"},
		"empty":       {`return await agent('  ')`, "prompt must be a non-empty string"},
		"syntax":      {"return (", "the script threw"},
		"line":        {"\n\nnull.x", "workflow.js:4"},
	} {
		t.Run(name, func(t *testing.T) {
			out := runTestWorkflow(t, tc.body, nil, 0, &fakeWorkflowHost{})
			if !strings.Contains(out.Err, tc.want) {
				t.Fatalf("err = %q, want it to contain %q", out.Err, tc.want)
			}
		})
	}
	dated := runTestWorkflow(t, `return new Date(Date.UTC(2026, 10, 19)).toISOString()`, nil, 0, &fakeWorkflowHost{})
	if dated.Err != "" || dated.Result != `"2026-11-19T00:00:00.000Z"` {
		t.Fatalf("a date from arguments: %+v", dated)
	}
}

func TestWorkflowCallLimit(t *testing.T) {
	host := &fakeWorkflowHost{answer: func(workflowCall) workflowCallResult { return workflowCallResult{OK: true} }}
	out := runTestWorkflow(t, `
let n = 0
try { for (;;) { await agent('x'); n++ } } catch (e) { return [n, e.name] }
`, nil, 0, host)
	if out.Result != `[1000,"WorkflowCallLimit"]` {
		t.Fatalf("outcome = %+v", out)
	}
}

func TestWorkflowStop(t *testing.T) {
	host := &fakeWorkflowHost{block: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan workflowOutcome)
	go func() {
		done <- runWorkflowScript(ctx, testMeta+`return await parallel([() => agent('a'), () => agent('b')])`, nil, 0, host)
	}()
	for {
		host.mu.Lock()
		n := len(host.calls)
		host.mu.Unlock()
		if n == 2 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	select {
	case out := <-done:
		if out.Err == "" {
			t.Fatalf("a stopped workflow returned %+v", out)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the workflow did not stop")
	}

	// A busy loop is interrupted too.
	ctx2, cancel2 := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel2()
	out := runWorkflowScript(ctx2, testMeta+`for (;;) {}`, nil, 0, &fakeWorkflowHost{})
	if !strings.Contains(out.Err, "stopped") {
		t.Fatalf("busy loop: %+v", out)
	}
}

func TestDelegateCallLogKeepsToolsApart(t *testing.T) {
	log := &delegateCallLog{changed: make(chan struct{}), sessions: map[string][]*delegateCall{}}
	log.note("s1", evToolUse, map[string]interface{}{"id": "wf_1", "name": "orbit__workflow", "input": map[string]interface{}{"description": "Review"}})
	log.note("s1", evToolUse, map[string]interface{}{"id": "call_1", "name": "orbit__delegate", "input": map[string]interface{}{"prompt": "p"}})
	// A workflow's own call is drawn as a delegate call but is nobody's to take.
	log.note("s1", evToolUse, map[string]interface{}{"id": "wf_1#0", "name": delegateEngineToolName, "workflowRunId": "w", "input": map[string]interface{}{"prompt": "p"}})
	if got := log.take("s1", delegateToolName, "p", "", 0); got != "call_1" {
		t.Fatalf("delegate took %q", got)
	}
	if got := log.take("s1", workflowToolName, "", "Review", 0); got != "wf_1" {
		t.Fatalf("workflow took %q", got)
	}
	if got := log.take("s1", delegateToolName, "p", "", 0); got != "" {
		t.Fatalf("a workflow call was taken as a delegate call: %q", got)
	}
}
