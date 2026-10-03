package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
)

// The plan's closed sets and numbers are the contract's (`plan`): a section kind this build does not
// know is one the server refuses, and one the server does not know is one this build would send.
func TestWikiPlanClosedSetsAreTheContracts(t *testing.T) {
	plan := wikiContract(t)["plan"].(map[string]interface{})
	keysOf := func(value interface{}) []string {
		out := []string{}
		for key := range value.(map[string]interface{}) {
			out = append(out, key)
		}
		sort.Strings(out)
		return out
	}
	sorted := func(values []string) []string {
		out := append([]string{}, values...)
		sort.Strings(out)
		return out
	}
	list := func(value interface{}) []string {
		out := []string{}
		for _, item := range value.([]interface{}) {
			out = append(out, item.(string))
		}
		return out
	}
	proposals := plan["proposals"].(map[string]interface{})
	gate := plan["gate"].(map[string]interface{})
	for name, pair := range map[string][2][]string{
		"statuses":           {keysOf(plan["statuses"]), sorted(wikiPlanStatuses)},
		"sectionKinds":       {keysOf(plan["sectionKinds"]), sorted(wikiPlanSectionKinds)},
		"proposals.statuses": {keysOf(proposals["statuses"]), sorted(wikiPlanProposalStatuses)},
		"proposals.facts":    {list(proposals["factKinds"]), wikiPlanFactKinds},
		"gate.checks":        {list(gate["checks"]), wikiPlanGateChecks},
		"newFields.levels":   {list(plan["newFields"].(map[string]interface{})["levels"]), wikiPlanNewFieldLevels},
	} {
		if !reflect.DeepEqual(pair[0], pair[1]) {
			t.Errorf("plan.%s = %v, this build has %v", name, pair[0], pair[1])
		}
	}
	for _, kind := range wikiPlanRepoRefKinds {
		if !strings.Contains(gate["repo"].(string), kind) {
			t.Errorf("gate.repo does not name the reference kind %s", kind)
		}
	}
	rules := plan["rules"].(map[string]interface{})
	if int(rules["docsMin"].(float64)) != wikiPlanDocsMin || int(rules["docsMax"].(float64)) != wikiPlanDocsMax {
		t.Errorf("rules = %v–%v documents, this build has %d–%d", rules["docsMin"], rules["docsMax"], wikiPlanDocsMin, wikiPlanDocsMax)
	}
	statuses := map[string]float64{}
	for _, refusal := range wikiContract(t)["refusals"].([]interface{}) {
		r := refusal.(map[string]interface{})
		statuses[r["code"].(string)] = r["httpStatus"].(float64)
	}
	for code, status := range map[string]float64{wikiPlanGateCode: 422, wikiPlanStaleCode: 409, wikiPlanUnconfirmedCode: 409} {
		if statuses[code] != status {
			t.Errorf("refusal %s = %v, this build reads it as %v", code, statuses[code], status)
		}
	}
}

// How a gate reads a closed-set value and names what it refuses is the contract's (`plan.gate.values`): the
// wrappers it takes off are the ones the contract lists, in its order, and what it names back is a JSON string.
func TestWikiPlanGateValuesAreTheContracts(t *testing.T) {
	values := wikiContract(t)["plan"].(map[string]interface{})["gate"].(map[string]interface{})["values"].(string)
	listed := regexp.MustCompile(`\(([^()]*)\) wrap the whole of it`).FindStringSubmatch(values)
	if listed == nil {
		t.Fatalf("plan.gate.values lists no wrappers: %s", values)
	}
	shipped := []string{}
	for _, pair := range wikiWrappers {
		if pair[0] == pair[1] {
			shipped = append(shipped, pair[0])
		} else {
			shipped = append(shipped, pair[0]+pair[1])
		}
	}
	if declared := strings.Fields(listed[1]); !reflect.DeepEqual(declared, shipped) {
		t.Errorf("plan.gate.values takes off %v, this build %v", declared, shipped)
	}
	for _, phrase := range []string{
		"writes it as a JSON string", `written as \uXXXX`, "a section's kind, a session condition's entryKinds and topics",
		"a pair counting as a wrapping only with no more of either inside", "nothing else is read loosely",
		"The runner's own gate (plan.jobs.run) and a maintenance run's check of its proposal read and write values the same way",
	} {
		if !strings.Contains(values, phrase) {
			t.Errorf("plan.gate.values does not say %q", phrase)
		}
	}
	// What a revision hands the model names projects as the drafting prompts do.
	revise := wikiContract(t)["plan"].(map[string]interface{})["jobs"].(map[string]interface{})["run"].(map[string]interface{})["revise"].(string)
	if !strings.Contains(revise, "name their session conditions' projects by title") || !strings.Contains(revise, "never by an id the model would have to copy") {
		t.Errorf("plan.jobs.run.revise does not say how a revision names projects: %s", revise)
	}
	if got := wikiQuote(" `decision`​"); got != "\" `decision`\\u200b\"" {
		t.Errorf("a refused value is named %s", got)
	}
}

// A draft and a proposal marshal to exactly the fields the contract's schema lists at each level: none
// missing, none the server would refuse as made up.
func TestWikiPlanDraftCarriesTheContractsFieldsAndNoOther(t *testing.T) {
	plan := wikiContract(t)["plan"].(map[string]interface{})
	schema := plan["schema"].(map[string]interface{})
	one, section, since, until, at := 1, "Execution model", "2026-09-01", "2026-09-28", "docs[0].sections[0].code[0]"
	doc := wikiPlanDoc{
		Category: "product", Slug: "session-runtime", Title: "会话运行模型", Question: "How does a session run?",
		Audience: []string{"A new developer"}, ScopeIn: []string{"Delivery"},
		ScopeOut: []wikiPlanScopeOut{{Text: "The state model", Docs: []string{"session-state"}}},
		Length:   wikiPlanLength{Min: 3000, Max: 4500}, Protected: true, Extra: map[string]interface{}{"audienceLevel": "new"},
		Sections: []wikiPlanSection{{
			Key: "s1", Title: "How it runs", Kind: "flow", Covers: "The steps.", Length: 800, Extra: map[string]interface{}{"evidenceWeight": "decision"},
			Sources: wikiPlanSources{
				Docs:      []wikiPlanDocSource{{Path: "docs/architecture.md", Section: &section}},
				Code:      []wikiPlanCodeSource{{Path: "src/runner-go/runloop.go", Symbols: []string{"runLoop()"}}},
				Contracts: []wikiPlanContractSource{{Path: "contracts/wiki.contract.json"}},
				Sessions: &wikiPlanSessions{
					Projects: []string{"Orbit Wiki · 阶段 2"}, Since: &since, Until: &until, Keywords: []string{"plan"},
					AnchorPaths: []string{"src/apiserver/src/wiki/"}, EntryKinds: []string{"pitfall"}, Topics: []string{"wiki"}, Evidence: "the owner's words",
				},
			},
		}},
	}
	category := wikiPlanCategory{Key: "product", Title: "Product", Question: "What Orbit is", ForAgents: true, Extra: map[string]interface{}{"order": 1}}
	request := wikiPlanDraftRequest{
		BaseVersion: &one,
		Target:      &wikiPlanLength{Min: wikiPlanDocsMin, Max: wikiPlanDocsMax},
		Plan: wikiPlanDraft{
			Categories: []wikiPlanCategory{category},
			Docs:       []wikiPlanDoc{doc},
			NewFields:  []wikiPlanNewField{{At: "section", Name: "evidenceWeight", Why: "the merge orders material by it"}},
		},
		RepoCheck: wikiPlanRepoCheck{Sha: strings.Repeat("a", 40), Checked: 3, Missing: []wikiPlanRepoMiss{{Kind: "symbol", Ref: "runLoop()", At: &at}}},
		Model:     "qwen3.8-27b-fp8",
	}
	request.IdempotencyKey = wikiPlanDraftKey("job-1", "session-1", request)
	var tree map[string]interface{}
	raw, _ := json.Marshal(request)
	if err := json.Unmarshal(raw, &tree); err != nil {
		t.Fatal(err)
	}
	object := func(value interface{}) map[string]interface{} { return value.(map[string]interface{}) }
	first := func(value interface{}) map[string]interface{} {
		return value.([]interface{})[0].(map[string]interface{})
	}
	check := func(level string, got map[string]interface{}) {
		t.Helper()
		keys := []string{}
		for key := range got {
			keys = append(keys, key)
		}
		want := []string{}
		for _, key := range schema[level].([]interface{}) {
			want = append(want, key.(string))
		}
		sort.Strings(keys)
		sort.Strings(want)
		if !reflect.DeepEqual(keys, want) {
			t.Errorf("a %s marshals to %v; the contract's schema lists %v", level, keys, want)
		}
	}
	draft := object(tree["plan"])
	check("draft", draft)
	check("category", first(draft["categories"]))
	check("newField", first(draft["newFields"]))
	d := first(draft["docs"])
	check("doc", d)
	check("scopeOut", first(d["scopeOut"]))
	check("length", object(d["length"]))
	s := first(d["sections"])
	check("section", s)
	sources := object(s["sources"])
	check("sources", sources)
	check("docSource", first(sources["docs"]))
	check("codeSource", first(sources["code"]))
	check("contractSource", first(sources["contracts"]))
	check("sessions", object(sources["sessions"]))
	requests := plan["requests"].(map[string]interface{})
	for key := range tree {
		if !strings.Contains(requests["draft"].(string), key) {
			t.Errorf("a draft request carries %s, which the contract's draft request does not name", key)
		}
	}
	if _, keyed := tree["idempotencyKey"]; !keyed {
		t.Error("a draft request does not carry its idempotency key")
	}
	var proposal map[string]interface{}
	raw, _ = json.Marshal(wikiPlanProposalRequest{Reason: "It fits no section.", Change: wikiPlanChange{Doc: doc, Category: &category}, Facts: []wikiPlanFact{{Kind: "entry", ID: "34WEntry"}}})
	if err := json.Unmarshal(raw, &proposal); err != nil {
		t.Fatal(err)
	}
	for key := range proposal {
		if !strings.Contains(requests["propose"].(string), key) {
			t.Errorf("a proposal carries %s, which the contract's proposal does not name", key)
		}
	}
	check("doc", object(object(proposal["change"])["doc"]))
	check("category", object(object(proposal["change"])["category"]))
}

// The three calls go to the contract's routes, which are the runner door's maintenance routes, as the
// calling session; a refusal of the gate reads back as everything it found, and nothing else does.
func TestWikiPlanCallsTheContractsRoutesAndReadsTheGatesRefusal(t *testing.T) {
	var mu sync.Mutex
	calls := []string{}
	var drafted map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		calls = append(calls, r.Method+" "+strings.Replace(r.URL.Path, "/space-1/", "/:id/", 1)+" as "+r.Header.Get("X-Orbit-Session-Id"))
		w.Header().Set("content-type", "application/json")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/plan/drafts"):
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &drafted)
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = w.Write([]byte(`{"code":"WIKI_PLAN_GATE","message":"The draft did not pass the plan's gate (docCount, references): 2 errors.","errors":[` +
				`{"check":"docCount","path":"plan.docs","message":"the plan has 19 documents; it must have 20 to 35"},` +
				`{"check":"references","path":"plan.docs[3].sections[2].sources.sessions.topics[1]","message":"engineering is not a topic of this space"}]}`))
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/plan/proposals"):
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"code":"WIKI_PLAN_UNCONFIRMED","message":"this space has no plan its owner confirmed"}`))
		default:
			_, _ = w.Write([]byte(`{"spaceId":"space-1","confirmed":null,"draft":null,"proposals":[]}`))
		}
	}))
	t.Cleanup(srv.Close)
	transport := NewTransport(srv.URL, "runner-token")

	if _, err := transport.wikiPlanState("session-1", "space-1"); err != nil {
		t.Fatal(err)
	}
	_, err := transport.submitWikiPlanDraft("session-1", "space-1", wikiPlanDraftRequest{Plan: wikiPlanDraft{Categories: []wikiPlanCategory{}, Docs: []wikiPlanDoc{}}})
	refusal, ok := wikiPlanGateRefused(err)
	if !ok {
		t.Fatalf("the gate's refusal did not read as one: %v", err)
	}
	if len(refusal.Errors) != 2 || refusal.Errors[0].Check != "docCount" || refusal.Errors[1].Path != "plan.docs[3].sections[2].sources.sessions.topics[1]" {
		t.Errorf("the gate's errors = %+v", refusal.Errors)
	}
	if value, present := drafted["baseVersion"]; !present || value != nil {
		t.Errorf("a first draft sends baseVersion null, and sent %v", drafted["baseVersion"])
	}
	_, err = transport.proposeWikiPlanChange("session-1", "space-1", wikiPlanProposalRequest{Reason: "x"})
	if err == nil || !strings.Contains(err.Error(), wikiPlanUnconfirmedCode) {
		t.Errorf("the proposal's refusal = %v", err)
	}
	if _, ok := wikiPlanGateRefused(err); ok {
		t.Error("a 409 read as a refusal of the gate")
	}

	routes := wikiContract(t)["plan"].(map[string]interface{})["routes"].(map[string]interface{})
	maintenance := map[string]bool{}
	for _, route := range wikiContract(t)["agentSurface"].(map[string]interface{})["doors"].(map[string]interface{})["runner"].(map[string]interface{})["maintenanceRoutes"].([]interface{}) {
		maintenance[route.(string)] = true
	}
	want := []string{}
	for _, name := range []string{"runnerState", "draft", "propose"} {
		route := routes[name].(string)
		if !maintenance[route] {
			t.Errorf("route %s (%s) is not a maintenance route of the runner door", name, route)
		}
		want = append(want, route+" as session-1")
	}
	mu.Lock()
	defer mu.Unlock()
	if !reflect.DeepEqual(calls, want) {
		t.Errorf("the calls = %v, the contract's routes %v", calls, want)
	}
}

// A draft's key is its run's and its own (contract `plan.idempotency`): the same draft of the same run is the
// same key however often it is sent — the key itself left out of what is digested — and a later round's draft,
// the same draft on another base, or another run's is another. The server takes a key of at most 200 characters.
func TestWikiPlanDraftKeyIsTheRunsAndTheDrafts(t *testing.T) {
	one := 1
	draft := wikiPlanDraftRequest{Target: &wikiPlanLength{Min: 3, Max: 3}, Plan: wikiPlanDraft{Categories: []wikiPlanCategory{{Key: "product", Title: "Product"}}},
		RepoCheck: wikiPlanRepoCheck{Sha: strings.Repeat("a", 40), Checked: 3}, Model: "qwen3.8-27b-fp8"}
	key := wikiPlanDraftKey("job-1", "session-1", draft)
	if !strings.HasPrefix(key, "wiki-plan-") || len(key) > 200 {
		t.Fatalf("the key %q is not the run's, or longer than the server takes", key)
	}
	sent := draft
	sent.IdempotencyKey = key
	if again := wikiPlanDraftKey("job-1", "session-1", sent); again != key {
		t.Errorf("the same draft sent under its key digests to %s, not %s", again, key)
	}
	later := draft
	later.Plan = wikiPlanDraft{Categories: []wikiPlanCategory{{Key: "product", Title: "Product, redone"}}}
	rebased := draft
	rebased.BaseVersion = &one
	for name, other := range map[string]string{
		"a later round's draft":          wikiPlanDraftKey("job-1", "session-1", later),
		"the same draft on another base": wikiPlanDraftKey("job-1", "session-1", rebased),
		"another job's":                  wikiPlanDraftKey("job-2", "session-1", draft),
		"another session's":              wikiPlanDraftKey("job-1", "session-2", draft),
	} {
		if other == key {
			t.Errorf("%s draft has the same key", name)
		}
	}
}
