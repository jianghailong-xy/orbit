package main

import (
	"encoding/json"
	"flag"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// wikiContract is contracts/wiki.contract.json, the file the TypeScript halves read as well: the
// tool names, the ops, the limits and the description agents are given are all in there, and this
// side is held to it rather than trusted to have copied it correctly.
func wikiContract(t *testing.T) map[string]interface{} {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "contracts", "wiki.contract.json"))
	if err != nil {
		t.Fatal(err)
	}
	var contract map[string]interface{}
	if err := json.Unmarshal(raw, &contract); err != nil {
		t.Fatal(err)
	}
	return contract
}

func wikiSurface(t *testing.T) map[string]interface{} {
	t.Helper()
	return wikiContract(t)["agentSurface"].(map[string]interface{})
}

func wikiDescriptor(t *testing.T, name string) map[string]interface{} {
	t.Helper()
	for _, tool := range toolDescriptors(false, false) {
		if tool["name"] == name {
			return tool
		}
	}
	t.Fatalf("no %s among the tools this binary offers", name)
	return nil
}

func wikiToolText(t *testing.T, result map[string]interface{}) string {
	t.Helper()
	content, _ := result["content"].([]map[string]interface{})
	if len(content) == 0 {
		t.Fatalf("tool result has no content: %#v", result)
	}
	text, _ := content[0]["text"].(string)
	return text
}

// wikiRequest is one request the wiki door was sent.
type wikiRequest struct {
	method, uri, session string
	body                 map[string]interface{}
}

// wikiDoor is a runner wiki door that records every request and answers each with status and reply.
func wikiDoor(t *testing.T, status int, reply string) (*httptest.Server, *[]wikiRequest) {
	t.Helper()
	var requests []wikiRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		request := wikiRequest{method: r.Method, uri: r.URL.RequestURI(), session: r.Header.Get("X-Orbit-Session-Id")}
		if raw, _ := io.ReadAll(r.Body); len(raw) > 0 {
			if err := json.Unmarshal(raw, &request.body); err != nil {
				t.Errorf("%s %s sent a body that is not JSON: %s", r.Method, r.URL.Path, raw)
			}
		}
		requests = append(requests, request)
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(reply))
	}))
	t.Cleanup(srv.Close)
	return srv, &requests
}

func wikiMCP(t *testing.T, serverURL string) *mcpServer {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	return &mcpServer{t: NewTransport(serverURL, "runner-token"), sessionID: "caller-session"}
}

const wikiSearchReply = `{"q":"trgm index","semantic":false,"hits":[` +
	`{"id":"34UuAT2stjMI2hEFUKr9X","kind":"decision","title":"pg_trgm over ILIKE","summary":"The keyword leg uses the trigram index.",` +
	`"trust":"confirmed","anchorState":"verified","match":["keyword"],"score":0.032787}]}`

// ── The surface ─────────────────────────────────────────────────────────────────────────────────

// Three tools, and no more: the contract names them, the CLI has a command per tool (the parity test
// walks that), and the two halves of this file — tool descriptors and capability specs — are here.
// A fourth tool added on one side is caught by whichever table the other side did not grow.
func TestWikiAgentSurfaceIsTheContracts(t *testing.T) {
	surface := wikiSurface(t)
	tools := surface["tools"].([]interface{})
	if len(tools) != len(wikiToolNames) {
		t.Errorf("this binary serves %d wiki tools, the contract names %d", len(wikiToolNames), len(tools))
	}
	names := map[string]bool{}
	for _, raw := range tools {
		name := raw.(string)
		names[name] = true
		if !wikiToolNames[name] {
			t.Errorf("the contract names %s, and no tool is served under that name", name)
		}
	}
	for name := range wikiToolNames {
		if !names[name] {
			t.Errorf("this binary serves %s, which the contract does not name", name)
		}
	}

	// The risk split, which is the whole reason there are three tools: the contract says which are
	// read-only and whether the one that writes destroys anything, and the annotations say it to the
	// engine that decides whether to ask a human first.
	specs := surface["toolSpecs"].(map[string]interface{})
	for _, name := range []string{"wiki_search", "wiki_get", "wiki_propose"} {
		spec := specs[name].(map[string]interface{})
		annotations, _ := wikiDescriptor(t, name)["annotations"].(map[string]interface{})
		if annotations == nil {
			t.Errorf("%s carries no annotations, so nothing tells the engine what it does", name)
			continue
		}
		if got, _ := annotations["readOnlyHint"].(bool); got != spec["readOnly"].(bool) {
			t.Errorf("%s declares readOnlyHint=%v here and readOnly=%v in the contract", name, got, spec["readOnly"])
		}
		if destructive, named := spec["destructive"]; named {
			if got := annotations["destructiveHint"]; destructive.(bool) == false && got != nil && got.(bool) != false {
				t.Errorf("%s is not destructive in the contract and says %v here", name, got)
			}
		}
		if _, present := wikiDescriptor(t, name)["outputSchema"]; !present {
			t.Errorf("%s has no outputSchema, so every answer is prose", name)
		}
	}

	// The parameters an agent is told it may send are the contract's own list, verb by name: a
	// parameter added to the server and forgotten here is a capability nobody can reach.
	params := map[string][]string{
		"wiki_search":  {"query", "kinds", "topic", "paths", "limit"},
		"wiki_get":     {"ids", "include"},
		"wiki_propose": {"ops", "rationale", "idempotencyKey", "dryRun"},
	}
	for name, want := range params {
		schema := wikiDescriptor(t, name)["inputSchema"].(map[string]interface{})
		props, _ := schema["properties"].(map[string]interface{})
		for _, param := range want {
			if _, present := props[param]; !present {
				t.Errorf("%s has no %s parameter", name, param)
			}
		}
		if len(props) != len(want) {
			t.Errorf("%s offers %v, the contract names %v", name, sortedParamNames(props), want)
		}
	}

	// The closed sets live in the contract, and an enum spelled differently here is a request the
	// server refuses for a reason the tool description never mentioned. Only the PHASE 1 kinds are
	// offered: `assumption` is the contract's reserved phase-3 kind, and an agent proposing one would
	// be writing a kind the server refuses.
	kinds := wikiContract(t)["kinds"].(map[string]interface{})
	for kind, raw := range kinds {
		if !contains(wikiEntryKinds, kind) {
			if raw.(map[string]interface{})["phase"].(float64) != 1 {
				continue
			}
			t.Errorf("the contract has a phase-1 %s kind this binary does not offer", kind)
		}
	}
	for _, kind := range wikiEntryKinds {
		if _, present := kinds[kind]; !present {
			t.Errorf("this binary offers the %s kind, which the contract does not name", kind)
		}
	}
	if contains(wikiEntryKinds, "assumption") {
		t.Error("the reserved phase-3 kind `assumption` is offered as one an agent may propose")
	}
	ops := wikiContract(t)["ops"].(map[string]interface{})
	for op := range ops {
		if !contains(wikiOpNames, op) {
			t.Errorf("the contract has an %s op this binary does not offer", op)
		}
	}
	if len(ops) != len(wikiOpNames) {
		t.Errorf("this binary offers ops %v, the contract has %d", wikiOpNames, len(ops))
	}
	matches := wikiContract(t)["searchMatches"].(map[string]interface{})
	for match := range matches {
		if !contains(wikiSearchMatches, match) {
			t.Errorf("the contract has a %s match this binary cannot report", match)
		}
	}

	// The limits a schema states are the contract's, or the tool promises a request the server
	// refuses with a code the caller was never warned about.
	limits := wikiContract(t)["limits"].(map[string]interface{})
	for _, bound := range []struct {
		name string
		got  int
		want float64
	}{
		{"searchLimitMax", wikiSearchLimitMax, limits["searchLimitMax"].(float64)},
		{"getIdsMax", wikiGetIDsMax, limits["getIdsMax"].(float64)},
		{"opsPerTurn", wikiOpsPerTurn, limits["opsPerTurn"].(float64)},
	} {
		if float64(bound.got) != bound.want {
			t.Errorf("%s = %d here, %v in the contract", bound.name, bound.got, bound.want)
		}
	}

	// And the CLI half: the same verb, named by the contract.
	cli := surface["cli"].(map[string]interface{})
	for tool, command := range cli {
		var argv []string
		for _, spec := range wikiCLICapabilities {
			if spec.Tool == tool {
				argv = spec.Argv
			}
		}
		if argv == nil {
			t.Errorf("the contract maps %s to %q, and this binary has no command for it", tool, command)
			continue
		}
		if got := strings.Join(argv, " "); got != command.(string) {
			t.Errorf("%s is %q here and %q in the contract", tool, got, command)
		}
	}

	// The ops an agent may propose, and the one thing it may never do.
	notTools, _ := surface["notTools"].(string)
	if notTools == "" || !strings.Contains(notTools, "decide") {
		t.Errorf("the contract stopped saying what an agent cannot do: %q", notTools)
	}
	if !wikiToolNames["wiki_propose"] || wikiToolNames["wiki_decide"] || wikiToolNames["wiki_accept"] {
		t.Errorf("the wiki tools = %v, and deciding is not one of them", wikiToolNames)
	}
}

// The precondition, word for word, and before the mechanics. This is the copy that decides whether
// a session tells its user it saved something: a description that leads with ops[] and rationale
// reads as a write that happened, and the sentence that says otherwise is the one it skims past.
func TestWikiProposeDescriptionIsAPrecondition(t *testing.T) {
	contract := wikiSurface(t)["proposeDescription"].(string)
	if contract == "" {
		t.Fatal("the contract lost agentSurface.proposeDescription")
	}
	if wikiProposePrecondition != contract {
		t.Fatalf("the precondition this binary ships is not the contract's:\n here: %q\n there: %q", wikiProposePrecondition, contract)
	}
	description, _ := wikiDescriptor(t, "wiki_propose")["description"].(string)

	// Every sentence of it, verbatim: a paraphrase is how "waits for the owner's review" becomes
	// "the owner will see it" and the reader starts treating the write as done.
	for _, sentence := range strings.Split(contract, ". ") {
		sentence = strings.TrimSpace(sentence)
		if sentence == "" {
			continue
		}
		if !strings.Contains(description, sentence) {
			t.Errorf("the description does not carry the contract's own sentence %q", sentence)
		}
	}
	// Before the mechanics, not after them: the first thing the caller reads is the bar it has to
	// clear, and only then how to send it.
	at := strings.Index(description, wikiProposePrecondition)
	ops := strings.Index(description, "ops[]")
	if at < 0 || ops < 0 || at > ops {
		t.Errorf("the precondition is not stated before ops[] (precondition at %d, ops[] at %d)", at, ops)
	}
	if strings.Index(description, "wiki_propose") > 0 {
		t.Errorf("the description names itself before it states the precondition")
	}

	// The three claims, each as words rather than as the shape they might be worded into.
	for _, phrase := range []string{
		"Record only what someone could not read from the code",
		"a decision and what was rejected",
		"a pitfall and its fix, a convention",
		"Cite the turns or records it came from",
		"a claim you cannot cite is not ready",
		"What you propose waits for the owner's review",
		"do not tell the user it is saved",
		// And what the caller may not do with it: there is no tool, and the owner's decision is
		// the only door. A model that believes it can confirm will offer to.
		"You cannot accept, confirm, delete or overwrite an entry",
		"the owner's decision is the only door",
		// Recording it is not the same as it being true: what is recorded is a proposal either way.
		"nothing here is knowledge yet",
	} {
		if !strings.Contains(description, phrase) {
			t.Errorf("the wiki_propose description does not say %q", phrase)
		}
	}
	// Both halves of the copy the memory rule is about: ask first, and say what happens next.
	for _, word := range []string{"cite", "proposal", "owner"} {
		if !containsWord(description, word) {
			t.Errorf("the description never says %q", word)
		}
	}
	// And the two tools that only read do NOT carry it: a precondition about writing on a search
	// tool is noise, and noise is what makes the reader skim the real one.
	for _, name := range []string{"wiki_search", "wiki_get"} {
		text, _ := wikiDescriptor(t, name)["description"].(string)
		if strings.Contains(text, "do not tell the user it is saved") {
			t.Errorf("%s carries the proposal precondition", name)
		}
	}
}

// ── What the tools send ─────────────────────────────────────────────────────────────────────────

func TestWikiToolsSendWhatWasAskedToTheirRoutes(t *testing.T) {
	cases := []struct {
		name  string
		args  map[string]interface{}
		uri   string
		reply string
		body  map[string]interface{}
	}{
		{
			name: "wiki_search",
			args: map[string]interface{}{
				"query": "trgm index",
				"kinds": []interface{}{"decision", "pitfall"},
				"topic": "search",
				"paths": []interface{}{"src/apiserver/src/wiki"},
				"limit": float64(3),
			},
			// url.Values sorts its keys, so this is the wire order rather than the order written.
			uri:   "/api/runner/wiki/search?kind=decision&kind=pitfall&limit=3&paths=src%2Fapiserver%2Fsrc%2Fwiki&q=trgm+index&topic=search",
			reply: wikiSearchReply,
		},
		{
			name:  "wiki_search: a path with no words is a query of its own",
			args:  map[string]interface{}{"paths": []interface{}{"src/runner-go"}},
			uri:   "/api/runner/wiki/search?paths=src%2Frunner-go",
			reply: wikiSearchReply,
		},
		{
			name:  "wiki_get: the door's default carries the sources",
			args:  map[string]interface{}{"ids": []interface{}{"e1"}},
			uri:   "/api/runner/wiki/entries/e1",
			reply: `{"id":"e1","kind":"pitfall","anchors":[]}`,
		},
		{
			name:  "wiki_get: history is the door's include=all",
			args:  map[string]interface{}{"ids": []interface{}{"e1"}, "include": []interface{}{"history"}},
			uri:   "/api/runner/wiki/entries/e1?include=all",
			reply: `{"id":"e1","kind":"pitfall","anchors":[]}`,
		},
		{
			name:  "wiki_get: none reads the entry alone",
			args:  map[string]interface{}{"ids": []interface{}{"e1"}, "include": []interface{}{"none"}},
			uri:   "/api/runner/wiki/entries/e1?include=none",
			reply: `{"id":"e1","kind":"pitfall","anchors":[]}`,
		},
		{
			name: "wiki_propose",
			args: map[string]interface{}{
				"ops":            []interface{}{map[string]interface{}{"op": "reinforce", "entryId": "e1", "sources": []interface{}{map[string]interface{}{"kind": "turn", "session": "self"}}}},
				"rationale":      "the fix is in the code now",
				"idempotencyKey": " t5-1 ",
				"dryRun":         true,
			},
			uri: "/api/runner/wiki/changesets",
			body: map[string]interface{}{
				"ops":            []interface{}{map[string]interface{}{"op": "reinforce", "entryId": "e1", "sources": []interface{}{map[string]interface{}{"kind": "turn", "session": "self"}}}},
				"rationale":      "the fix is in the code now",
				"idempotencyKey": "t5-1",
				"dryRun":         true,
			},
			reply: `{"changesetId":null,"replayed":false,"ops":[{"seq":0,"status":"applied","revision":2,"entryId":"e1"}]}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, requests := wikiDoor(t, http.StatusOK, tc.reply)
			name := strings.SplitN(tc.name, ":", 2)[0]
			result := wikiMCP(t, srv.URL).callTool(name, tc.args)
			if result["isError"] == true {
				t.Fatalf("%s failed: %s", name, wikiToolText(t, result))
			}
			if len(*requests) != 1 {
				t.Fatalf("requests = %#v, want one", *requests)
			}
			got := (*requests)[0]
			if got.uri != tc.uri || got.session != "caller-session" {
				t.Fatalf("request = %s %s (session %q), want %s from caller-session", got.method, got.uri, got.session, tc.uri)
			}
			wantMethod := http.MethodGet
			if name == "wiki_propose" {
				wantMethod = http.MethodPost
			}
			if got.method != wantMethod {
				t.Fatalf("method = %s, want %s", got.method, wantMethod)
			}
			if tc.body != nil && !reflect.DeepEqual(got.body, tc.body) {
				t.Fatalf("body = %#v\nwant %#v", got.body, tc.body)
			}
			// Every one of them is a control-plane call the engine can see the answer of: the
			// structured content is what an outputSchema promises, and the text is the fallback.
			if _, ok := result["structuredContent"]; !ok {
				t.Errorf("%s answered without structuredContent, which its outputSchema promises", name)
			}
		})
	}
}

// wiki_get reads several ids in one call, one request each, and the answer keeps the order it was
// asked in: an id that is missing does not silently renumber the rest.
func TestWikiGetReadsEachIdOnItsOwnRoute(t *testing.T) {
	srv, requests := wikiDoor(t, http.StatusOK, `{"id":"e1","kind":"pitfall","anchors":[]}`)
	result := wikiMCP(t, srv.URL).callTool("wiki_get", map[string]interface{}{"ids": []interface{}{"e1", "e2", "e1"}})
	if result["isError"] == true {
		t.Fatalf("wiki_get failed: %s", wikiToolText(t, result))
	}
	want := []string{"/api/runner/wiki/entries/e1", "/api/runner/wiki/entries/e2"}
	if len(*requests) != len(want) {
		t.Fatalf("requests = %#v, want %d", *requests, len(want))
	}
	for i, uri := range want {
		if (*requests)[i].uri != uri {
			t.Errorf("request %d = %s, want %s", i, (*requests)[i].uri, uri)
		}
	}
}

func TestWikiToolsRefuseMalformedRequestsWithoutSendingThem(t *testing.T) {
	srv, requests := wikiDoor(t, http.StatusOK, wikiSearchReply)
	mcp := wikiMCP(t, srv.URL)
	oneID := []interface{}{"e1"}
	tooMany := []interface{}{"e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "e10", "e11"}
	tooManyOps := []interface{}{}
	for i := 0; i < wikiOpsPerTurn+1; i++ {
		tooManyOps = append(tooManyOps, map[string]interface{}{"op": "add"})
	}
	cases := []struct {
		tool string
		args map[string]interface{}
		says string
	}{
		{"wiki_search", map[string]interface{}{}, "query is required"},
		{"wiki_search", map[string]interface{}{"query": "x", "kinds": []interface{}{"assumption"}}, "kinds[0] must be one of"},
		{"wiki_search", map[string]interface{}{"query": "x", "limit": float64(50)}, "limit must be an integer from 1 to 10"},
		{"wiki_search", map[string]interface{}{"query": "x", "limit": "many"}, "limit must be an integer from 1 to 10"},
		{"wiki_get", map[string]interface{}{}, "ids is required"},
		{"wiki_get", map[string]interface{}{"ids": tooMany}, "at most 10"},
		{"wiki_get", map[string]interface{}{"ids": []interface{}{"../sessions"}}, "single safe path segment"},
		{"wiki_get", map[string]interface{}{"ids": oneID, "include": []interface{}{"none", "history"}}, "cannot be combined"},
		{"wiki_get", map[string]interface{}{"ids": oneID, "include": []interface{}{"everything"}}, "include must name"},
		{"wiki_propose", map[string]interface{}{}, "ops is required"},
		{"wiki_propose", map[string]interface{}{"ops": []interface{}{map[string]interface{}{"op": "delete", "entryId": "e1"}}, "rationale": "r", "idempotencyKey": "k"}, "ops[0].op must be one of"},
		{"wiki_propose", map[string]interface{}{"ops": []interface{}{"add"}, "rationale": "r", "idempotencyKey": "k"}, "ops[0] must be an object"},
		{"wiki_propose", map[string]interface{}{"ops": tooManyOps, "rationale": "r", "idempotencyKey": "k"}, "at most 5"},
		{"wiki_propose", map[string]interface{}{"ops": []interface{}{map[string]interface{}{"op": "add"}}, "idempotencyKey": "k"}, "rationale is required"},
		{"wiki_propose", map[string]interface{}{"ops": []interface{}{map[string]interface{}{"op": "add"}}, "rationale": "r"}, "idempotencyKey is required"},
		{"wiki_propose", map[string]interface{}{"ops": "ops.json", "rationale": "r", "idempotencyKey": "k"}, "ops must be a JSON array"},
	}
	for _, tc := range cases {
		result := mcp.callTool(tc.tool, tc.args)
		text := wikiToolText(t, result)
		if result["isError"] != true || !strings.Contains(text, tc.says) {
			t.Errorf("%s(%v) = %q (isError %v), want a refusal saying %q", tc.tool, tc.args, text, result["isError"], tc.says)
		}
	}
	if len(*requests) != 0 {
		t.Fatalf("a refused request reached the server: %#v", *requests)
	}
}

// ── What the caller is told ─────────────────────────────────────────────────────────────────────

func TestWikiProposeReportsAProposalNotASavedEntry(t *testing.T) {
	pending := `{"changesetId":"cs-1","replayed":false,"ops":[` +
		`{"seq":0,"status":"pending","opId":"o1","entryId":"e1","similar":[{"id":"e9","kind":"pitfall","title":"The same trap","status":"active","trust":"confirmed","score":0.4}]},` +
		`{"seq":1,"status":"applied","opId":"o2","entryId":"e2","revision":2}]}`
	srv, _ := wikiDoor(t, http.StatusOK, pending)
	args := map[string]interface{}{
		"ops": []interface{}{
			map[string]interface{}{"op": "add"},
			map[string]interface{}{"op": "reinforce", "entryId": "e2"},
		},
		"rationale":      "learned it fixing T5",
		"idempotencyKey": "t5-1",
	}
	result := wikiMCP(t, srv.URL).callTool("wiki_propose", args)
	if result["isError"] == true {
		t.Fatalf("wiki_propose failed: %s", wikiToolText(t, result))
	}
	text := wikiToolText(t, result)
	for _, phrase := range []string{
		"Recorded as a proposal for the owner's review",
		"It is not saved",
		"never as a saved entry",
		"op 0 add: pending",
		"op 1 reinforce: applied (now revision 2)",
		"similar: e9 The same trap",
	} {
		if !strings.Contains(text, phrase) {
			t.Errorf("the answer does not say %q:\n%s", phrase, text)
		}
	}
	structured, _ := result["structuredContent"].(wikiProposeAnswer)
	if structured.ChangesetID != "cs-1" || len(structured.Ops) != 2 {
		t.Errorf("structuredContent = %#v, want the server's own answer", result["structuredContent"])
	}

	// A dry run records nothing, and says so before it says anything else — a model that reports
	// the per-op statuses of a dry run as if they had happened is the failure this copy prevents.
	dry := `{"changesetId":null,"replayed":false,"ops":[{"seq":0,"status":"applied","opId":null,"entryId":null,"revision":null}]}`
	srv, _ = wikiDoor(t, http.StatusOK, dry)
	dryArgs := map[string]interface{}{
		"ops":            []interface{}{map[string]interface{}{"op": "add"}},
		"rationale":      "learned it fixing T5",
		"idempotencyKey": "t5-2",
		"dryRun":         true,
	}
	text = wikiToolText(t, wikiMCP(t, srv.URL).callTool("wiki_propose", dryArgs))
	if !strings.HasPrefix(text, "Dry run: every op was checked, and NOTHING was recorded") {
		t.Errorf("a dry run does not lead with the fact that nothing was recorded:\n%s", text)
	}

	// A replayed key is not a second proposal, and the answer says which it is.
	replayed := `{"changesetId":"cs-1","replayed":true,"ops":[{"seq":0,"status":"pending","opId":"o1","entryId":"e1"}]}`
	srv, _ = wikiDoor(t, http.StatusOK, replayed)
	text = wikiToolText(t, wikiMCP(t, srv.URL).callTool("wiki_propose", args))
	if !strings.Contains(text, "already recorded under this idempotencyKey") {
		t.Errorf("a replayed answer does not say it is the recorded one:\n%s", text)
	}
}

// A batch none of whose ops was recorded answers with the first refusal's status AND every op's
// outcome in the body. That body is the answer — the per-op reasons, the current revision of a
// conflict — and reading the 4xx as a failed call throws away the only thing worth reading.
func TestWikiProposeReadsARefusedBatchAsAnAnswer(t *testing.T) {
	refused := `{"changesetId":null,"replayed":false,"ops":[` +
		`{"seq":0,"status":"refused","reasons":[{"code":"WIKI_SOURCE_UNRESOLVED","message":"the turn it cites is not yours"}]},` +
		`{"seq":1,"status":"conflict","entryId":"e2","baseRevision":3,"currentRevision":5,"current":{"title":"now"},"diff":"- old\n+ now"}]}`
	srv, _ := wikiDoor(t, http.StatusUnprocessableEntity, refused)
	result := wikiMCP(t, srv.URL).callTool("wiki_propose", map[string]interface{}{
		"ops": []interface{}{
			map[string]interface{}{"op": "reinforce", "entryId": "e1"},
			map[string]interface{}{"op": "amend", "entryId": "e2", "baseRevision": float64(3)},
		},
		"rationale":      "r",
		"idempotencyKey": "k",
	})
	if result["isError"] == true {
		t.Fatalf("a refused batch came back as a failed call, losing the per-op answer: %s", wikiToolText(t, result))
	}
	text := wikiToolText(t, result)
	for _, phrase := range []string{
		"Nothing was recorded: every op was refused",
		"op 0 reinforce: refused WIKI_SOURCE_UNRESOLVED: the turn it cites is not yours",
		"op 1 amend: conflict",
		"written against revision 3, which is now 5",
		"wiki_get",
	} {
		if !strings.Contains(text, phrase) {
			t.Errorf("the answer does not say %q:\n%s", phrase, text)
		}
	}

	// A refusal with no ops in it is not an answer: the wiki is off, this session is excluded from
	// knowledge work, or the space is not bound, and the caller has to be told which.
	excluded := `{"code":"WIKI_SESSION_EXCLUDED","message":"this session verifies work, and knowledge is not evidence"}`
	srv, _ = wikiDoor(t, http.StatusForbidden, excluded)
	result = wikiMCP(t, srv.URL).callTool("wiki_propose", map[string]interface{}{
		"ops":            []interface{}{map[string]interface{}{"op": "add"}},
		"rationale":      "r",
		"idempotencyKey": "k",
	})
	if result["isError"] != true || !strings.Contains(wikiToolText(t, result), "knowledge is not evidence") {
		t.Errorf("a request-level refusal was not carried to the caller: %v %s", result["isError"], wikiToolText(t, result))
	}
}

// One id that cannot be read is an answer among several, and it says what the server said.
func TestWikiGetReportsIdsItCouldNotRead(t *testing.T) {
	missing := `{"message":"no such wiki entry","error":"Not Found","statusCode":404}`
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("content-type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/e2") {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(missing))
			return
		}
		_, _ = w.Write([]byte(`{"id":"e1","kind":"pitfall","anchors":[]}`))
	}))
	defer srv.Close()
	result := wikiMCP(t, srv.URL).callTool("wiki_get", map[string]interface{}{"ids": []interface{}{"e1", "e2"}})
	if result["isError"] == true {
		t.Fatalf("one unreadable id failed the whole call: %s", wikiToolText(t, result))
	}
	text := wikiToolText(t, result)
	if !strings.Contains(text, "1 entry read; 1 id could not be") || !strings.Contains(text, "no such wiki entry") {
		t.Errorf("the answer does not report the id it could not read:\n%s", text)
	}
	answer, _ := result["structuredContent"].(wikiGetAnswer)
	if len(answer.Entries) != 1 || len(answer.Errors) != 1 || answer.Errors[0].ID != "e2" {
		t.Errorf("structuredContent = %#v, want one entry and one error", result["structuredContent"])
	}
}

// The search result is a list an agent reads, with what each entry is and where it came from.
func TestWikiSearchAnswersWithEntriesAndTheirMatch(t *testing.T) {
	srv, _ := wikiDoor(t, http.StatusOK, wikiSearchReply)
	text := wikiToolText(t, wikiMCP(t, srv.URL).callTool("wiki_search", map[string]interface{}{"query": "trgm index"}))
	for _, phrase := range []string{
		"1 entry for \"trgm index\"",
		"keyword and path recall; semantic search is off",
		"34UuAT2stjMI2hEFUKr9X",
		"pg_trgm over ILIKE",
		"confirmed",
		"anchor verified",
		"matched: keyword",
		"wiki_get",
		"orbit-wiki:<id>",
	} {
		if !strings.Contains(text, phrase) {
			t.Errorf("the search answer does not say %q:\n%s", phrase, text)
		}
	}

	// Nothing matched is an answer too, and it does not send the caller off to propose noise.
	srv, _ = wikiDoor(t, http.StatusOK, `{"q":"nothing like it","semantic":false,"hits":[]}`)
	text = wikiToolText(t, wikiMCP(t, srv.URL).callTool("wiki_search", map[string]interface{}{"query": "nothing like it"}))
	if !strings.Contains(text, "No entry in this space matches") || !strings.Contains(text, "nothing was changed by this call") {
		t.Errorf("an empty search does not say what it means:\n%s", text)
	}
}

// Every field of a search hit is declared in the outputSchema: the answer is what the schema says it
// is, or an engine validating structuredContent rejects the call.
func TestWikiSearchStructuredContentMatchesItsSchema(t *testing.T) {
	schema := wikiDescriptor(t, "wiki_search")["outputSchema"].(map[string]interface{})
	props, _ := schema["properties"].(map[string]interface{})
	hits := props["hits"].(map[string]interface{})
	item := hits["items"].(map[string]interface{})
	hitProps, _ := item["properties"].(map[string]interface{})
	var answer wikiSearchAnswer
	if err := json.Unmarshal([]byte(wikiSearchReply), &answer); err != nil {
		t.Fatal(err)
	}
	if len(answer.Hits) == 0 {
		t.Fatal("the fixture lost its hits")
	}
	raw, _ := json.Marshal(answer.Hits[0])
	var decoded map[string]interface{}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	for field := range decoded {
		if _, declared := hitProps[field]; !declared {
			t.Errorf("a hit carries %q, which the outputSchema does not declare: an engine validating it refuses the call", field)
		}
	}
	if _, ok := props["hits"]; !ok {
		t.Error("the search outputSchema does not declare hits")
	}

	// And the answer the tool actually builds conforms: the one field an engine checks first is
	// that structuredContent is an object.
	srv, _ := wikiDoor(t, http.StatusOK, wikiSearchReply)
	result := wikiMCP(t, srv.URL).callTool("wiki_search", map[string]interface{}{"query": "trgm index"})
	structured, ok := result["structuredContent"].(wikiSearchAnswer)
	if !ok {
		t.Fatalf("structuredContent = %#v, want a search answer", result["structuredContent"])
	}
	if len(structured.Hits) != 1 || structured.Hits[0].Kind != "decision" || structured.Hits[0].Match[0] != "keyword" {
		t.Errorf("structuredContent lost the answer: %#v", structured)
	}
}

// ── Doors, versions and the switch ──────────────────────────────────────────────────────────────

func TestWikiToolsActOnlyForTheSessionTheyRunIn(t *testing.T) {
	unreachable := NewTransport("http://127.0.0.1:1", "runner-token")
	outside := &mcpServer{t: unreachable}
	for name := range wikiToolNames {
		result := outside.callTool(name, map[string]interface{}{"query": "x", "ids": []interface{}{"e1"}, "ops": []interface{}{map[string]interface{}{"op": "add"}}})
		if result["isError"] != true || !strings.Contains(wikiToolText(t, result), "session") {
			t.Errorf("%s ran with no session to act for: %s", name, wikiToolText(t, result))
		}
	}
	// Offered to every agent, unlike the session_* tools: reading what your own workspace shares and
	// proposing what you learned is not a power over anybody else's session.
	for name := range wikiToolNames {
		if !hasMCPTool(toolDescriptors(false, false), name) {
			t.Errorf("%s is withheld from an agent with no orchestration grant", name)
		}
	}
}

func TestWikiToolsSayPlainlyWhenTheServerHasNoWikiDoor(t *testing.T) {
	missingRoute := `{"message":"Cannot GET /api/runner/wiki/search","error":"Not Found","statusCode":404}`
	srv, _ := wikiDoor(t, http.StatusNotFound, missingRoute)
	text := wikiToolText(t, wikiMCP(t, srv.URL).callTool("wiki_search", map[string]interface{}{"query": "x"}))
	for _, phrase := range []string{"no wiki door", "Upgrade the Orbit server", "404 for /api/runner/wiki"} {
		if !strings.Contains(text, phrase) {
			t.Errorf("an older server's 404 does not say %q: %s", phrase, text)
		}
	}

	// The read door's own 404 is not a missing door: an id that names nothing this session may read
	// is an answer about that id.
	missingEntry := `{"message":"no such wiki entry","error":"Not Found","statusCode":404}`
	srv, _ = wikiDoor(t, http.StatusNotFound, missingEntry)
	text = wikiToolText(t, wikiMCP(t, srv.URL).callTool("wiki_get", map[string]interface{}{"ids": []interface{}{"e1"}}))
	if strings.Contains(text, "no wiki door") || !strings.Contains(text, "no such wiki entry") {
		t.Errorf("an entry this session cannot read reads as a missing door: %s", text)
	}

	// And a server that HAS the door and has the wiki switched off says so, rather than sending the
	// caller to upgrade the server it is already talking to.
	disabled := `{"code":"WIKI_DISABLED","message":"the wiki is off for this account"}`
	srv, _ = wikiDoor(t, http.StatusNotFound, disabled)
	text = wikiToolText(t, wikiMCP(t, srv.URL).callTool("wiki_search", map[string]interface{}{"query": "x"}))
	if strings.Contains(text, "no wiki door") || !strings.Contains(text, wikiDisabledCode) || !strings.Contains(text, "switch") {
		t.Errorf("a wiki that is off reads as a missing door: %s", text)
	}
}

// The rollout switch: a session spawned with ORBIT_WIKI=off has no wiki tools at all — not a tool
// that fails, but no tool — and `orbit capabilities` does not offer the commands either. Same shape
// as ORBIT_WATCHES (watch_rollout.go), because a session that cannot read the wiki must not be told
// to.
func TestWikiIsOffWhenTheFlagSaysSo(t *testing.T) {
	t.Setenv(envWiki, "off")
	if wikiEnabledFromEnv() {
		t.Fatal("ORBIT_WIKI=off reads as on")
	}
	srv, requests := wikiDoor(t, http.StatusOK, wikiSearchReply)
	off := wikiMCP(t, srv.URL)
	off.wikiOff = true
	for name := range wikiToolNames {
		result := off.callTool(name, map[string]interface{}{"query": "x", "ids": []interface{}{"e1"}, "ops": []interface{}{map[string]interface{}{"op": "add"}}})
		if result["isError"] != true || !strings.Contains(wikiToolText(t, result), "ORBIT_WIKI=off") {
			t.Errorf("%s with the wiki off = %s, want the refusal that names ORBIT_WIKI=off", name, wikiToolText(t, result))
		}
	}
	if len(*requests) != 0 {
		t.Fatalf("a call with the wiki off reached the server: %#v", *requests)
	}
	// Removed rather than refused: an agent that can see the tool asks for it, and a model told to
	// use what it learned has no way to know the refusal means "not here" rather than "not now".
	stripped := withoutWikiTools(toolDescriptors(false, true))
	for name := range wikiToolNames {
		if hasMCPTool(stripped, name) {
			t.Errorf("%s is still offered with the wiki off", name)
		}
	}
	for _, kept := range []string{"task_list", "watch_create", "project_get"} {
		if !hasMCPTool(stripped, kept) {
			t.Errorf("turning the wiki off dropped %s along with it", kept)
		}
	}

	// The capability document and the commands themselves, for the CLI half.
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	document := buildCLICapabilities("/usr/local/bin/orbit")
	if ids := capabilityIDs(document); contains(ids, "wiki_search") {
		t.Errorf("capabilities offer wiki_search with the wiki off: %v", ids)
	}
	t.Setenv(envWiki, "on")
	document = buildCLICapabilities("/usr/local/bin/orbit")
	for name := range wikiToolNames {
		if !contains(capabilityIDs(document), name) {
			t.Errorf("capabilities with the wiki on do not offer %s: %v", name, capabilityIDs(document))
		}
	}
}

func capabilityIDs(document cliCapabilitiesDocument) []string {
	ids := make([]string, 0, len(document.Capabilities))
	for _, capability := range document.Capabilities {
		ids = append(ids, capability.ID)
	}
	return ids
}

func TestWikiCommandsNeedASessionAndTheSwitch(t *testing.T) {
	var out strings.Builder
	t.Setenv(envWiki, "on")
	t.Setenv("ORBIT_SESSION_ID", "")
	err := cmdWikiCLI([]string{"search", "anything"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "ORBIT_SESSION_ID") {
		t.Errorf("orbit wiki search outside a session = %v, want the refusal that names ORBIT_SESSION_ID", err)
	}
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envWiki, "off")
	for _, command := range [][]string{{"search", "anything"}, {"get", "e1"}, {"propose", "--ops", "[]"}} {
		err := cmdWikiCLI(command, strings.NewReader(""), &out)
		if err == nil || !strings.Contains(err.Error(), "ORBIT_WIKI=off") {
			t.Errorf("orbit wiki %s with the wiki off = %v, want the refusal that names ORBIT_WIKI=off", command[0], err)
		}
	}
	// The family's own help is reachable, which is what makes the per-action text worth writing:
	// a family missing from leafHelpFamilies still compiles and answers --help with the overview.
	if !ownsLeafHelp("wiki") || helpFor("wiki") != wikiHelp {
		t.Error("`orbit wiki --help` does not reach the family's own help")
	}
	if _, ok := cmdHelp["wiki"]; !ok || !strings.Contains(usage, "orbit wiki") {
		t.Error("`orbit` and `orbit help` do not list the wiki family")
	}
	for _, action := range []string{"search", "get", "propose"} {
		var text strings.Builder
		if err := cmdWikiCLI([]string{action, "--help"}, strings.NewReader(""), &text); err != nil {
			t.Fatalf("orbit wiki %s --help: %v", action, err)
		}
		if text.String() != wikiActionHelp[action] {
			t.Errorf("orbit wiki %s --help does not print its own help", action)
		}
	}
}

// ── The CLI's half of the same arguments ────────────────────────────────────────────────────────

// The CLI runs the same tool as MCP, against a real door and a real runner config: the wiring is
// what this catches — a verb that reaches the tool under the wrong name answers "unknown wiki tool",
// and nothing about the shared runWikiTool would say so.
func TestWikiCLIRunsTheSameToolAsMCP(t *testing.T) {
	srv, requests := wikiDoor(t, http.StatusOK, wikiSearchReply)
	home := t.TempDir()
	// The credential is only read from storage an agent cannot read: the command refuses an
	// ORBIT_HOME anybody else could look into, so the fixture has to be private too.
	if err := os.Chmod(home, 0o700); err != nil {
		t.Fatal(err)
	}
	config := `{"serverUrl":` + strconv.Quote(srv.URL) + `,"runnerId":"r1","runnerToken":"runner-token","name":"test"}`
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ORBIT_HOME", home)
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envWiki, "on")

	var out strings.Builder
	if err := cmdWikiCLI([]string{"search", "trgm index", "--kind", "decision", "--limit", "2"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("orbit wiki search: %v", err)
	}
	if !strings.Contains(out.String(), "pg_trgm over ILIKE") {
		t.Errorf("the command did not print the answer: %q", out.String())
	}
	if len(*requests) != 1 || (*requests)[0].uri != "/api/runner/wiki/search?kind=decision&limit=2&q=trgm+index" {
		t.Fatalf("requests = %#v, want one search from the flags", *requests)
	}

	// get, whose ids come off the same line the query does.
	if err := cmdWikiCLI([]string{"get", "e1,e2", "--include", "history"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("orbit wiki get: %v", err)
	}
	if len(*requests) != 3 || (*requests)[1].uri != "/api/runner/wiki/entries/e1?include=all" || (*requests)[2].uri != "/api/runner/wiki/entries/e2?include=all" {
		t.Fatalf("requests = %#v, want one read per id with the history", *requests)
	}

	// --json prints the structured answer alone, which is what a script reads.
	var jsonOut strings.Builder
	if err := cmdWikiCLI([]string{"search", "trgm index", "--json"}, strings.NewReader(""), &jsonOut); err != nil {
		t.Fatalf("orbit wiki search --json: %v", err)
	}
	var decoded wikiSearchAnswer
	if err := json.Unmarshal([]byte(jsonOut.String()), &decoded); err != nil {
		t.Fatalf("--json printed something that is not the answer: %v (%q)", err, jsonOut.String())
	}
	if len(decoded.Hits) != 1 || decoded.Hits[0].ID == "" {
		t.Errorf("the structured answer lost its hits: %#v", decoded)
	}

	// And a proposal goes the same way, with the answer the batch came back with.
	proposal := `{"changesetId":null,"replayed":false,"ops":[{"seq":0,"status":"pending","opId":null,"entryId":null}]}`
	srv.Close()
	srv, requests = wikiDoor(t, http.StatusOK, proposal)
	// The door moved, so the config the command reads has to move with it.
	if err := os.WriteFile(filepath.Join(home, "config.json"),
		[]byte(`{"serverUrl":`+strconv.Quote(srv.URL)+`,"runnerId":"r1","runnerToken":"runner-token","name":"test"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	ops := `[{"op":"add","entry":{"kind":"pitfall","title":"t","summary":"s","fields":{"trigger":{"paths":["a"]}}}}]`
	err := cmdWikiCLI([]string{"propose", "--ops", ops, "--rationale", "why", "--idempotency-key", "k1", "--dry-run"},
		strings.NewReader(""), &out)
	if err != nil {
		t.Fatalf("orbit wiki propose: %v", err)
	}
	if !strings.Contains(out.String(), "Dry run") || !strings.Contains(out.String(), "op 0 add: pending") {
		t.Errorf("the proposal answer was not reported: %q", out.String())
	}
	if len(*requests) != 1 || (*requests)[0].method != http.MethodPost || (*requests)[0].uri != "/api/runner/wiki/changesets" {
		t.Fatalf("requests = %#v, want one POST to the changeset door", *requests)
	}
	if (*requests)[0].body["dryRun"] != true || (*requests)[0].body["rationale"] != "why" {
		t.Errorf("the flags did not reach the body: %#v", (*requests)[0].body)
	}
}

// The CLI and the MCP tool read the same argument map through the same runWikiTool, so what is left
// to drift is the translation: flags into that map. It is asserted here rather than trusted.
func TestWikiCLIFlagsBecomeTheToolArguments(t *testing.T) {
	search, err := wikiSearchToolArgs([]string{"trgm", "index"}, stringList{"decision"}, "search", stringList{"src/wiki"}, 3, true)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]interface{}{
		"query": "trgm index",
		"kinds": []string{"decision"},
		"topic": "search",
		"paths": []string{"src/wiki"},
		"limit": float64(3),
	}
	if !reflect.DeepEqual(search, want) {
		t.Errorf("search flags = %#v\nwant %#v", search, want)
	}
	// A path with no words is a query of its own — the path leg is the one that answers it — and
	// neither is nothing at all.
	if _, err := wikiSearchToolArgs(nil, nil, "", stringList{"src/runner-go"}, 0, false); err != nil {
		t.Errorf("a path-only search was refused: %v", err)
	}
	if _, err := wikiSearchToolArgs(nil, nil, "", nil, 0, false); err == nil {
		t.Error("a search with no query and no path was accepted")
	}
	if _, err := wikiSearchToolArgs([]string{"x"}, nil, "", nil, 0, true); err == nil || !strings.Contains(err.Error(), "--limit must be a whole number from 1 to 10") {
		t.Errorf("--limit 0 was accepted: %v", err)
	}

	get, err := wikiGetToolArgs([]string{"e1,e2", "e3"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(get, map[string]interface{}{"ids": []string{"e1", "e2", "e3"}}) {
		t.Errorf("get flags = %#v", get)
	}
	if _, err := wikiGetToolArgs(nil, nil); err == nil {
		t.Error("orbit wiki get with no ids was accepted")
	}
	if got, err := wikiGetToolArgs([]string{"e1"}, stringList{"history"}); err != nil || !reflect.DeepEqual(got["include"], []string{"history"}) {
		t.Errorf("--include did not reach the tool arguments: %#v %v", got, err)
	}

	// propose: the ops as an array, or as the whole body a file written for this command holds.
	// The flag set is registered and parsed the way the command does it — --ops marks itself set by
	// being parsed, not by being passed — so a command that read a flag nobody typed would show here.
	propose := func(argv []string, ops, rationale, key string) (map[string]interface{}, error) {
		fs := newCLIFlagSet("orbit wiki propose")
		fs.String("ops", "", "")
		fs.String("ops-file", "", "")
		fs.String("rationale", "", "")
		fs.String("rationale-file", "", "")
		fs.String("idempotency-key", "", "")
		fs.Bool("dry-run", false, "")
		if err := fs.Parse(argv); err != nil {
			t.Fatal(err)
		}
		return wikiProposeToolArgs(strings.NewReader(""), fs, ops, "", rationale, "", key, false)
	}
	body := `{"ops":[{"op":"add","entry":{"kind":"pitfall"}}],"rationale":"from the body","idempotencyKey":"k1","dryRun":true}`
	args, err := propose([]string{"--ops", body}, body, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if args["rationale"] != "from the body" || args["idempotencyKey"] != "k1" || args["dryRun"] != true {
		t.Errorf("a whole body did not carry its own rationale, key and dry run: %#v", args)
	}
	ops, _ := args["ops"].([]interface{})
	if len(ops) != 1 {
		t.Errorf("ops from a body = %#v", args["ops"])
	}
	bare := `[{"op":"retire"}]`
	array, err := propose([]string{"--ops", bare, "--rationale", "why", "--idempotency-key", "k2"}, bare, "why", "k2")
	if err != nil {
		t.Fatal(err)
	}
	if array["rationale"] != "why" || array["idempotencyKey"] != "k2" {
		t.Errorf("flags did not fill in a bare ops array: %#v", array)
	}
	if _, err := propose([]string{"--ops", bare}, bare, "", ""); err == nil || !strings.Contains(err.Error(), "--rationale is required") {
		t.Errorf("a proposal with no rationale was accepted: %v", err)
	}
	if _, err := propose([]string{"--ops", bare, "--rationale", "why"}, bare, "why", ""); err == nil || !strings.Contains(err.Error(), "--idempotency-key is required") {
		t.Errorf("a proposal with no idempotency key was accepted: %v", err)
	}
	if _, err := propose(nil, "", "", "k"); err == nil || !strings.Contains(err.Error(), "--ops or --ops-file - is required") {
		t.Errorf("a proposal with no ops was accepted: %v", err)
	}

	// A model that sends the ops as a JSON string is read the same way over MCP.
	srv, requests := wikiDoor(t, http.StatusOK, `{"changesetId":"cs-1","replayed":false,"ops":[]}`)
	result := wikiMCP(t, srv.URL).callTool("wiki_propose", map[string]interface{}{
		"ops":            `[{"op":"add","entry":{"kind":"pitfall"}}]`,
		"rationale":      "r",
		"idempotencyKey": "k",
	})
	if result["isError"] == true {
		t.Fatalf("ops as a JSON string was refused: %s", wikiToolText(t, result))
	}
	if len(*requests) != 1 {
		t.Fatalf("requests = %#v, want one", *requests)
	}
	sent, _ := (*requests)[0].body["ops"].([]interface{})
	if len(sent) != 1 {
		t.Errorf("the string was not forwarded as an array: %#v", (*requests)[0].body)
	}
}

// The commands an agent is told about are the commands that exist, and the flags in the capability
// document are the flags the parsers take. cli_mcp_parity_test.go and
// cli_help_flag_coverage_test.go walk the tables; this checks the tables are about THIS family —
// that every advertised argument is one the parser accepts, so the document cannot describe a flag
// nobody wrote.
func TestWikiCapabilitiesDescribeTheFlagsTheParserTakes(t *testing.T) {
	for _, spec := range wikiCLICapabilities {
		if !wikiToolNames[spec.Tool] {
			t.Errorf("capability %s is advertised and is not a wiki tool", spec.Tool)
		}
		if spec.Argv[0] != "orbit" || spec.Argv[1] != "wiki" {
			t.Errorf("capability %s is %v, want `orbit wiki <verb>`", spec.Tool, spec.Argv)
		}
		if !spec.SessionOnly {
			t.Errorf("capability %s is advertised to a terminal outside a session, where it can only fail", spec.Tool)
		}
		documented := wikiActionHelp[spec.Argv[2]]
		for _, argument := range spec.Arguments {
			for _, flag := range strings.Fields(argument) {
				if !strings.HasPrefix(flag, "--") {
					continue
				}
				name := strings.TrimSuffix(strings.SplitN(strings.TrimPrefix(flag, "--"), "=", 2)[0], ",")
				if !strings.Contains(documented, "--"+name) {
					t.Errorf("`orbit wiki %s --help` does not document --%s, which capabilities advertises", spec.Argv[2], name)
				}
				if !writtenFlagIsParsed(spec.Argv[2], name) {
					t.Errorf("capabilities advertise --%s for `orbit wiki %s`, which its parser does not take", name, spec.Argv[2])
				}
			}
		}
	}
}

// writtenFlagIsParsed registers a command's flags the way the command does and reports whether the
// name is among them.
func writtenFlagIsParsed(action, name string) bool {
	fs := newCLIFlagSet("orbit wiki " + action)
	var list stringList
	switch action {
	case "search":
		fs.Var(&list, "kind", "")
		fs.Var(&list, "path", "")
		fs.String("topic", "", "")
		fs.Int("limit", 0, "")
	case "get":
		fs.Var(&list, "include", "")
	case "propose":
		fs.String("ops", "", "")
		fs.String("ops-file", "", "")
		fs.String("rationale", "", "")
		fs.String("rationale-file", "", "")
		fs.String("idempotency-key", "", "")
		fs.Bool("dry-run", false, "")
	default:
		return false
	}
	fs.Bool("json", false, "")
	found := false
	fs.VisitAll(func(flag *flag.Flag) {
		if flag.Name == name {
			found = true
		}
	})
	return found
}

// The agents that read the CLI's instructions are told to cite what they read, and a wiki entry is
// cited the way every other Orbit thing is: by a link the clients draw, not by a bare id.
func TestWikiInstructionsLinkEntriesAndPreApproveTheCommands(t *testing.T) {
	exe := "/usr/local/bin/orbit"
	instructions := orbitCLIInstructions(exe, true, true)
	if !strings.Contains(instructions, "orbit-wiki:<id>") {
		t.Errorf("the instructions do not tell an agent how to cite a wiki entry: %q", instructions)
	}
	if !strings.Contains(instructions, "`[title](orbit-wiki:<id>)`") {
		t.Errorf("the citation is not the link shape the clients draw: %q", instructions)
	}
	rules := strings.Join(orbitCLIAllowedTools(exe, false), "\n")
	for _, action := range []string{"search", "get", "propose"} {
		if !strings.Contains(rules, "Bash("+exe+" wiki "+action+" *)") {
			t.Errorf("orbit wiki %s is advertised and pre-approved for nobody: %q", action, rules)
		}
	}
	// The entry links join the ones the instruction paragraph already names, and none of those went.
	for _, link := range []string{"orbit-task:<id>", "orbit-session:<id>", "orbit-project:<id>", "orbit-list:<id>"} {
		if !strings.Contains(instructions, link) {
			t.Errorf("the link paragraph lost %s", link)
		}
	}
}
