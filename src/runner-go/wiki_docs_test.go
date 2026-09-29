package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
)

// The documents' closed sets and numbers are the contract's (`docs`): a verdict or a kind this build does
// not know is one the server would refuse, and one the server does not know is one this build would send.
func TestWikiDocsClosedSetsAreTheContracts(t *testing.T) {
	docs := wikiContract(t)["docs"].(map[string]interface{})
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
	for name, pair := range map[string][2][]string{
		"statuses":         {keysOf(docs["statuses"]), sorted(wikiDocStatuses)},
		"sentenceStatuses": {keysOf(docs["sentenceStatuses"]), sorted(wikiDocSentenceStatuses)},
		"footnoteKinds":    {keysOf(docs["footnoteKinds"]), sorted(append(append([]string{}, wikiDocRepoKinds...), wikiDocRecordKinds...))},
		"repoKinds":        {list(docs["repoKinds"]), wikiDocRepoKinds},
		"recordKinds":      {list(docs["recordKinds"]), wikiDocRecordKinds},
		"verdicts":         {keysOf(docs["verdicts"]), sorted(wikiDocVerdicts)},
		"checkers":         {keysOf(docs["checkers"]), sorted(wikiDocCheckers)},
		"withdrawReasons":  {list(docs["withdrawReasons"]), wikiDocWithdrawReasons},
	} {
		if !reflect.DeepEqual(pair[0], pair[1]) {
			t.Errorf("docs.%s = %v, this build has %v", name, pair[0], pair[1])
		}
	}
	rules := docs["rules"].(map[string]interface{})
	if rules["needsReviewAbove"].(float64) != wikiDocNeedsReviewAbove || int(rules["quoteMinChars"].(float64)) != wikiDocQuoteMinChars ||
		int(rules["sectionsPerWrite"].(float64)) != wikiDocSectionsPerWrite || int(rules["footnotesPerSection"].(float64)) != wikiDocFootnotesMax {
		t.Errorf("docs.rules = %v, this build has %v / %d / %d / %d", rules, wikiDocNeedsReviewAbove, wikiDocQuoteMinChars, wikiDocSectionsPerWrite, wikiDocFootnotesMax)
	}
	statuses := map[string]float64{}
	for _, refusal := range wikiContract(t)["refusals"].([]interface{}) {
		r := refusal.(map[string]interface{})
		statuses[r["code"].(string)] = r["httpStatus"].(float64)
	}
	if statuses[wikiDocInvalidCode] != 422 {
		t.Errorf("refusal %s = %v, this build reads it as 422", wikiDocInvalidCode, statuses[wikiDocInvalidCode])
	}
	// A session record's footnote comes back with its session beside its id: the deep link needs both,
	// and the section with the commit it was generated at, which the next run compares with origin/main.
	links := docs["links"].(map[string]interface{})["sessionRecord"].(string)
	for _, name := range []string{"recordId", "sessionId", "around="} {
		if !strings.Contains(links, name) {
			t.Errorf("docs.links.sessionRecord does not name %s: %s", name, links)
		}
	}
	if !strings.Contains(docs["reads"].(map[string]interface{})["writerState"].(string), "repoSha") {
		t.Error("docs.reads.writerState does not hand back the commit each section was generated at")
	}
}

// A write marshals to exactly the fields the contract's schema lists at each level — a repository footnote
// to a repository footnote's, a record's to a record's — and names no field the server would refuse.
func TestWikiDocWriteCarriesTheContractsFieldsAndNoOther(t *testing.T) {
	docs := wikiContract(t)["docs"].(map[string]interface{})
	schema := docs["schema"].(map[string]interface{})
	yes, quote := true, "export function claimTask("
	request := wikiDocWriteRequest{
		PlanVersion: 3,
		RepoSha:     strings.Repeat("c", 40),
		Model:       "qwen3.8-27b-fp8",
		Sections: []wikiDocSection{{
			Key:            "s2",
			MaterialSha256: strings.Repeat("d", 64),
			Markdown:       "派发由 `claimTask` 开始[1]。先存后投[2]。",
			Footnotes: []wikiDocFootnote{
				{
					Kind: "code", Path: "src/apiserver/src/tasks/tasks.service.ts", Sha: strings.Repeat("b", 40), Lines: &wikiDocRange{Start: 10, End: 20},
					Section: "Claim", Symbol: "claimTask", Excerpt: "export function claimTask(id: string) {", Verified: &yes, Quote: &quote, ViaEntryID: "34WEntry",
				},
				{Kind: "turn", Ref: "34WTurn", Chars: &wikiDocRange{Start: 0, End: 40}, Quote: &quote, ViaEntryID: "34WEntry"},
			},
		}},
	}
	var tree map[string]interface{}
	raw, _ := json.Marshal(request)
	if err := json.Unmarshal(raw, &tree); err != nil {
		t.Fatal(err)
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
	object := func(value interface{}) map[string]interface{} { return value.(map[string]interface{}) }
	check("write", tree)
	section := object(tree["sections"].([]interface{})[0])
	check("section", section)
	footnotes := section["footnotes"].([]interface{})
	check("repoFootnote", object(footnotes[0]))
	check("recordFootnote", object(footnotes[1]))
	check("lines", object(object(footnotes[0])["lines"]))
	check("chars", object(object(footnotes[1])["chars"]))
	for key := range tree {
		if !strings.Contains(docs["requests"].(map[string]interface{})["write"].(string), key) {
			t.Errorf("a write carries %s, which the contract's write request does not name", key)
		}
	}
	// A footnote with no quote says so as null, for the server to mark it no_quote.
	raw, _ = json.Marshal(wikiDocFootnote{Kind: "tool_call", Ref: "34WCall"})
	if !strings.Contains(string(raw), `"quote":null`) {
		t.Errorf("a footnote with no quote marshals to %s", raw)
	}
}

// The two calls go to the contract's routes, which are the runner door's maintenance routes, as the calling
// session; a refusal of the write's shape reads back as everything it found, and nothing else does.
func TestWikiDocsCallTheContractsRoutesAndReadTheRefusal(t *testing.T) {
	var mu sync.Mutex
	calls := []string{}
	var written map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		path := strings.Replace(strings.Replace(r.URL.Path, "/space-1/", "/:id/", 1), "/docs/session-runtime", "/docs/:slug", 1)
		calls = append(calls, r.Method+" "+path+" as "+r.Header.Get("X-Orbit-Session-Id"))
		w.Header().Set("content-type", "application/json")
		switch {
		case r.Method == http.MethodPost && written == nil:
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &written)
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = w.Write([]byte(`{"code":"WIKI_DOC_INVALID","message":"The document write does not have the shape the contract gives it (docs.schema): 2 errors.","errors":[` +
				`{"path":"sections[0].footnotes[1].sha","message":"a repository footnote is pinned to the commit it was read at: sha is required"},` +
				`{"path":"repoSha","message":"is required"}]}`))
		case r.Method == http.MethodPost:
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"code":"WIKI_PLAN_UNCONFIRMED","message":"this space has no plan its owner confirmed"}`))
		default:
			_, _ = w.Write([]byte(`{"spaceId":"space-1","planVersion":null,"docs":[]}`))
		}
	}))
	t.Cleanup(srv.Close)
	transport := NewTransport(srv.URL, "runner-token")

	if _, err := transport.wikiDocsState("session-1", "space-1"); err != nil {
		t.Fatal(err)
	}
	_, err := transport.writeWikiDoc("session-1", "space-1", "session-runtime", wikiDocWriteRequest{PlanVersion: 1, Sections: []wikiDocSection{}})
	refusal, ok := wikiDocRefused(err)
	if !ok {
		t.Fatalf("the refusal of the write's shape did not read as one: %v", err)
	}
	if len(refusal.Errors) != 2 || refusal.Errors[0].Path != "sections[0].footnotes[1].sha" || refusal.Errors[1].Path != "repoSha" {
		t.Errorf("the refusal's errors = %+v", refusal.Errors)
	}
	if written["planVersion"] != float64(1) {
		t.Errorf("the write sent planVersion %v", written["planVersion"])
	}
	_, err = transport.writeWikiDoc("session-1", "space-1", "session-runtime", wikiDocWriteRequest{PlanVersion: 1})
	if err == nil || !strings.Contains(err.Error(), "WIKI_PLAN_UNCONFIRMED") {
		t.Errorf("the second write's refusal = %v", err)
	}
	if _, ok := wikiDocRefused(err); ok {
		t.Error("a 409 read as a refusal of the write's shape")
	}

	routes := wikiContract(t)["docs"].(map[string]interface{})["routes"].(map[string]interface{})
	maintenance := map[string]bool{}
	for _, route := range wikiContract(t)["agentSurface"].(map[string]interface{})["doors"].(map[string]interface{})["runner"].(map[string]interface{})["maintenanceRoutes"].([]interface{}) {
		maintenance[route.(string)] = true
	}
	want := []string{}
	for _, name := range []string{"writerState", "write", "write"} {
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
