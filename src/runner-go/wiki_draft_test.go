package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// wiki_draft and the wiki chat's drafting answers (contracts/wiki.contract.json `agentSurface.chat`): a card the owner of
// a wiki chat presses, and nothing of the wiki written. The surface itself — the fifth tool's name, its params, its
// command — is TestWikiAgentSurfaceIsTheContracts'; this file holds what the tool says, sends and answers.

const wikiDraftReply = `{"status":"draft","draftId":"d2","kind":"rewrite","replayed":false,` +
	`"rewrites":[{"doc":"sessions-runtime","key":"leases","where":"1.1 §3","title":"Leases"}]}`

// The description goes to the model word for word: it is what keeps a chat from telling its owner a draft is applied.
func TestWikiDraftDescriptionIsTheContracts(t *testing.T) {
	chat := wikiSurface(t)["chat"].(map[string]interface{})
	draft := chat["draft"].(map[string]interface{})
	if got := draft["description"].(string); wikiDraftDescription != got {
		t.Fatalf("the description this binary ships is not the contract's:\n here: %q\n there: %q", wikiDraftDescription, got)
	}
	descriptor := wikiDescriptor(t, "wiki_draft")
	if descriptor["description"] != wikiDraftDescription {
		t.Errorf("wiki_draft's descriptor does not carry the contract's description")
	}
	for _, phrase := range []string{"never call a draft applied", "Works only in a wiki chat", "use wiki_propose"} {
		if !strings.Contains(wikiDraftDescription, phrase) {
			t.Errorf("the wiki_draft description does not say %q", phrase)
		}
	}
	// The closed set and the bound are the contract's: kind is rewrite or plan, and a card rewrites at most rewritesMax.
	props := descriptor["inputSchema"].(map[string]interface{})["properties"].(map[string]interface{})
	if got := props["kind"].(map[string]interface{})["enum"]; !reflect.DeepEqual(got, []string{"rewrite", "plan"}) {
		t.Errorf("kind = %v, want rewrite and plan", got)
	}
	max := wikiContract(t)["chat"].(map[string]interface{})["rules"].(map[string]interface{})["rewritesMax"].(float64)
	if got := props["sections"].(map[string]interface{})["maxItems"]; got != wikiDraftSectionsMax || float64(wikiDraftSectionsMax) != max {
		t.Errorf("sections maxItems = %v (const %d), the contract's rewritesMax is %v", got, wikiDraftSectionsMax, max)
	}
	required := descriptor["inputSchema"].(map[string]interface{})["required"]
	if !reflect.DeepEqual(required, []string{"kind", "reason", "idempotencyKey"}) {
		t.Errorf("wiki_draft requires %v", required)
	}
	// It writes a card and destroys nothing; and there is still no tool that accepts, confirms or decides.
	annotations := descriptor["annotations"].(map[string]interface{})
	if annotations["readOnlyHint"] != false || annotations["destructiveHint"] != false {
		t.Errorf("wiki_draft annotations = %v", annotations)
	}
	for name := range wikiToolNames {
		if strings.Contains(name, "accept") || strings.Contains(name, "confirm") || strings.Contains(name, "decide") || strings.Contains(name, "apply") {
			t.Errorf("a wiki tool named %s is a power the owner's door alone has", name)
		}
	}
	// The three drafting tools say what replaces is, in the same words.
	for _, name := range []string{"wiki_propose", "wiki_note", "wiki_draft"} {
		props := wikiDescriptor(t, name)["inputSchema"].(map[string]interface{})["properties"].(map[string]interface{})
		replaces, _ := props["replaces"].(map[string]interface{})
		if replaces == nil || replaces["description"] != wikiReplacesDescription {
			t.Errorf("%s does not take replaces as the wiki chat's card it replaces: %v", name, replaces)
		}
	}
}

func TestWikiDraftRefusesMalformedRequestsWithoutSendingThem(t *testing.T) {
	srv, requests := wikiDoor(t, http.StatusOK, wikiDraftReply)
	mcp := wikiMCP(t, srv.URL)
	one := []interface{}{map[string]interface{}{"doc": "sessions-runtime", "section": "leases"}}
	six := []interface{}{}
	for i := 0; i < wikiDraftSectionsMax+1; i++ {
		six = append(six, map[string]interface{}{"doc": "d", "section": "s" + strconv.Itoa(i)})
	}
	cases := []struct {
		args map[string]interface{}
		says string
	}{
		{map[string]interface{}{"sections": one, "reason": "r", "idempotencyKey": "k"}, "kind is required"},
		{map[string]interface{}{"kind": "entry", "sections": one, "reason": "r", "idempotencyKey": "k"}, "kind is required"},
		{map[string]interface{}{"kind": "rewrite", "sections": one, "idempotencyKey": "k"}, "reason is required"},
		{map[string]interface{}{"kind": "rewrite", "sections": one, "reason": "r"}, "idempotencyKey is required"},
		{map[string]interface{}{"kind": "rewrite", "reason": "r", "idempotencyKey": "k"}, "sections is required"},
		{map[string]interface{}{"kind": "rewrite", "sections": []interface{}{}, "reason": "r", "idempotencyKey": "k"}, "1 to 5"},
		{map[string]interface{}{"kind": "rewrite", "sections": six, "reason": "r", "idempotencyKey": "k"}, "1 to 5"},
		{map[string]interface{}{"kind": "rewrite", "sections": []interface{}{map[string]interface{}{"doc": "d"}}, "reason": "r", "idempotencyKey": "k"}, "sections[0] must name"},
		{map[string]interface{}{"kind": "rewrite", "sections": "not json", "reason": "r", "idempotencyKey": "k"}, "sections must be a JSON array"},
	}
	for _, tc := range cases {
		result := mcp.callTool("wiki_draft", tc.args)
		text := wikiToolText(t, result)
		if result["isError"] != true || !strings.Contains(text, tc.says) {
			t.Errorf("wiki_draft(%v) = %q (isError %v), want a refusal saying %q", tc.args, text, result["isError"], tc.says)
		}
	}
	if len(*requests) != 0 {
		t.Fatalf("a refused request reached the server: %#v", *requests)
	}
	// Sections a model sends as a JSON string are read the same way.
	result := mcp.callTool("wiki_draft", map[string]interface{}{
		"kind": "rewrite", "sections": `[{"doc":"sessions-runtime","section":"leases"}]`, "reason": "r", "idempotencyKey": "k",
	})
	if result["isError"] == true || len(*requests) != 1 {
		t.Fatalf("sections as a JSON string = %s, requests %#v", wikiToolText(t, result), *requests)
	}
	if got := (*requests)[0].body["sections"]; !reflect.DeepEqual(got, []interface{}{map[string]interface{}{"doc": "sessions-runtime", "section": "leases"}}) {
		t.Errorf("sections sent = %#v", got)
	}
	// The plan kind is the server's to refuse while it is not open: this side sends it as asked, with no sections.
	plan := mcp.callTool("wiki_draft", map[string]interface{}{"kind": "plan", "change": map[string]interface{}{"op": "edit"}, "reason": "r", "idempotencyKey": "k2"})
	if plan["isError"] == true || len(*requests) != 2 || (*requests)[1].body["kind"] != "plan" || (*requests)[1].body["sections"] != nil {
		t.Errorf("a plan draft was not sent as asked: %s %#v", wikiToolText(t, plan), *requests)
	}
}

// What the caller is told is the card, and that nothing was written: never that anything was applied.
func TestWikiDraftSaysACardNotAWrite(t *testing.T) {
	srv, _ := wikiDoor(t, http.StatusOK, wikiDraftReply)
	result := wikiMCP(t, srv.URL).callTool("wiki_draft", map[string]interface{}{
		"kind": "rewrite", "sections": []interface{}{map[string]interface{}{"doc": "sessions-runtime", "section": "leases"}}, "reason": "r", "idempotencyKey": "k",
	})
	text := wikiToolText(t, result)
	for _, phrase := range []string{"Drafted card d2 (rewrite)", "Nothing was written", "Never call it applied", "replaces: d2", "1.1 §3 Leases"} {
		if !strings.Contains(text, phrase) {
			t.Errorf("wiki_draft's answer does not say %q: %q", phrase, text)
		}
	}
	data, _ := result["structuredContent"].(wikiDraftAnswer)
	if data.DraftID != "d2" || data.Kind != "rewrite" || len(data.Rewrites) != 1 {
		t.Errorf("structuredContent = %#v", result["structuredContent"])
	}
	replayed := `{"status":"draft","draftId":"d2","kind":"rewrite","replayed":true,"rewrites":[]}`
	srv2, _ := wikiDoor(t, http.StatusOK, replayed)
	again := wikiToolText(t, wikiMCP(t, srv2.URL).callTool("wiki_draft", map[string]interface{}{
		"kind": "rewrite", "sections": []interface{}{map[string]interface{}{"doc": "s", "section": "k"}}, "reason": "r", "idempotencyKey": "k",
	}))
	if !strings.Contains(again, "already made card d2") || strings.Contains(again, "Drafted card") {
		t.Errorf("a replayed draft = %q", again)
	}
}

// Only a wiki chat drafts: the server refuses every other session, and this side says the server's words, not its own.
func TestWikiDraftRelaysTheServersRefusals(t *testing.T) {
	excluded := `{"code":"WIKI_SESSION_EXCLUDED","message":"wiki_draft works only in a wiki chat, where the owner presses each card: this session is no wiki chat."}`
	srv, requests := wikiDoor(t, http.StatusForbidden, excluded)
	result := wikiMCP(t, srv.URL).callTool("wiki_draft", map[string]interface{}{
		"kind": "rewrite", "sections": []interface{}{map[string]interface{}{"doc": "s", "section": "k"}}, "reason": "r", "idempotencyKey": "k",
	})
	text := wikiToolText(t, result)
	if result["isError"] != true || !strings.Contains(text, "WIKI_SESSION_EXCLUDED") || !strings.Contains(text, "works only in a wiki chat") {
		t.Errorf("a session that is no chat was told %q (isError %v)", text, result["isError"])
	}
	// A refusal is an answer: sent once, not again.
	if len(*requests) != 1 {
		t.Errorf("requests = %d, want the one", len(*requests))
	}
	schema := `{"code":"WIKI_SCHEMA","message":"a rewrite names written sections of the confirmed plan","errors":[{"path":"sections[0]","message":"is not a section of the confirmed plan"}]}`
	srv2, _ := wikiDoor(t, http.StatusBadRequest, schema)
	text = wikiToolText(t, wikiMCP(t, srv2.URL).callTool("wiki_draft", map[string]interface{}{
		"kind": "rewrite", "sections": []interface{}{map[string]interface{}{"doc": "s", "section": "k"}}, "reason": "r", "idempotencyKey": "k",
	}))
	if !strings.Contains(text, "WIKI_SCHEMA") || !strings.Contains(text, "sections[0]") {
		t.Errorf("a refused section was told %q", text)
	}
	// An Orbit server older than the tool has no route for it: said as that, not as a missing card or a wiki that is off.
	srv3, _ := wikiDoor(t, http.StatusNotFound, `{"message":"Cannot POST /api/runner/wiki/drafts"}`)
	text = wikiToolText(t, wikiMCP(t, srv3.URL).callTool("wiki_draft", map[string]interface{}{
		"kind": "rewrite", "sections": []interface{}{map[string]interface{}{"doc": "s", "section": "k"}}, "reason": "r", "idempotencyKey": "k",
	}))
	if !strings.Contains(text, "too old for wiki_draft") || !strings.Contains(text, "no card was made") {
		t.Errorf("an old server was reported as %q", text)
	}
}

// In a wiki chat, wiki_propose and a note's corrects make cards: what the agent is told is that nothing changed.
func TestWikiChatProposeAndNoteReportACard(t *testing.T) {
	chat := `{"status":"draft","draftId":"d1","replayed":false,"ops":[` +
		`{"seq":0,"status":"draft","entryId":null,"similar":[{"id":"e9","title":"Leases expire","score":0.4}]},` +
		`{"seq":1,"status":"refused","reasons":[{"code":"WIKI_SOURCE_UNRESOLVED","message":"cite it"}]}],` +
		`"similar":[{"id":"e9","title":"Leases expire","score":0.4}],"rewrites":[{"doc":"sessions-runtime","key":"leases","where":"1.1 §3","title":"Leases"}]}`
	srv, _ := wikiDoor(t, http.StatusOK, chat)
	result := wikiMCP(t, srv.URL).callTool("wiki_propose", map[string]interface{}{
		"ops":            []interface{}{map[string]interface{}{"op": "add"}, map[string]interface{}{"op": "reinforce", "entryId": "e2"}},
		"rationale":      "the owner said so",
		"idempotencyKey": "chat-1",
	})
	text := wikiToolText(t, result)
	for _, phrase := range []string{
		"Drafted card d1", "Nothing in the wiki changed", "never call it applied", "pass replaces: d1",
		"op 0 add: on the card; similar: e9 Leases expire", "op 1 reinforce: refused WIKI_SOURCE_UNRESOLVED", "rewrites: 1.1 §3 Leases",
	} {
		if !strings.Contains(text, phrase) {
			t.Errorf("a chat's proposal answer does not say %q:\n%s", phrase, text)
		}
	}
	for _, wrong := range []string{"Recorded", "live now", "is live"} {
		if strings.Contains(text, wrong) {
			t.Errorf("a chat's proposal answer says %q:\n%s", wrong, text)
		}
	}
	data, _ := result["structuredContent"].(wikiProposeAnswer)
	if data.Status != "draft" || data.DraftID != "d1" || len(data.Rewrites) != 1 || len(data.Similar) != 1 {
		t.Errorf("structuredContent = %#v", result["structuredContent"])
	}

	note := `{"noted":true,"noteId":"n1","created":true,"readBy":"the next maintenance run","challenged":{"status":"draft","draftId":"d3","entryId":"e1"}}`
	srv2, _ := wikiDoor(t, http.StatusOK, note)
	text = wikiToolText(t, wikiMCP(t, srv2.URL).callTool("wiki_note", map[string]interface{}{"text": "The lease is two minutes.", "corrects": "e1"}))
	if !strings.Contains(text, "the flag is card d3") || !strings.Contains(text, "NOT flagged until they do") || strings.Contains(text, "is flagged now") {
		t.Errorf("a chat's corrects was reported as %q", text)
	}
	// Outside a chat both answer as they always did.
	srv3, _ := wikiDoor(t, http.StatusOK, `{"changesetId":"cs-1","replayed":false,"ops":[{"seq":0,"status":"pending","opId":"o1","entryId":"e1"}]}`)
	text = wikiToolText(t, wikiMCP(t, srv3.URL).callTool("wiki_propose", map[string]interface{}{
		"ops": []interface{}{map[string]interface{}{"op": "add"}}, "rationale": "r", "idempotencyKey": "k",
	}))
	if !strings.Contains(text, "Recorded: changeset cs-1") || strings.Contains(text, "card") {
		t.Errorf("an ordinary session's proposal answer changed: %q", text)
	}
}

// `orbit wiki draft` runs the tool the MCP door runs, with the flags as its arguments.
func TestWikiDraftCLIRunsTheSameToolAsMCP(t *testing.T) {
	srv, requests := wikiDoor(t, http.StatusOK, wikiDraftReply)
	home := t.TempDir()
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
	argv := []string{"draft", "--kind", "rewrite", "--section", "sessions-runtime/leases", "--section", "sessions-runtime/turn-delivery",
		"--reason", "The lease moved on main.", "--idempotency-key", "k1", "--replaces", "d1"}
	if err := cmdWikiCLI(argv, strings.NewReader(""), &out); err != nil {
		t.Fatalf("orbit wiki draft: %v", err)
	}
	if !strings.Contains(out.String(), "Drafted card d2") {
		t.Errorf("the command did not print the answer: %q", out.String())
	}
	if len(*requests) != 1 || (*requests)[0].method != http.MethodPost || (*requests)[0].uri != "/api/runner/wiki/drafts" || (*requests)[0].session != "caller-session" {
		t.Fatalf("requests = %#v, want one POST to the draft door as the calling session", *requests)
	}
	cliBody := (*requests)[0].body
	want := map[string]interface{}{
		"kind": "rewrite",
		"sections": []interface{}{
			map[string]interface{}{"doc": "sessions-runtime", "section": "leases"},
			map[string]interface{}{"doc": "sessions-runtime", "section": "turn-delivery"},
		},
		"reason":         "The lease moved on main.",
		"idempotencyKey": "k1",
		"replaces":       "d1",
	}
	if !reflect.DeepEqual(cliBody, want) {
		t.Fatalf("the CLI sent %#v\nwant %#v", cliBody, want)
	}
	// The MCP door sends the same body for the same arguments.
	mcpSrv, mcpRequests := wikiDoor(t, http.StatusOK, wikiDraftReply)
	result := wikiMCP(t, mcpSrv.URL).callTool("wiki_draft", map[string]interface{}{
		"kind": "rewrite",
		"sections": []interface{}{
			map[string]interface{}{"doc": "sessions-runtime", "section": "leases"},
			map[string]interface{}{"doc": "sessions-runtime", "section": "turn-delivery"},
		},
		"reason": "The lease moved on main.", "idempotencyKey": "k1", "replaces": "d1",
	})
	if result["isError"] == true || len(*mcpRequests) != 1 || !reflect.DeepEqual((*mcpRequests)[0].body, cliBody) {
		t.Fatalf("the MCP door sent %#v, the CLI %#v", *mcpRequests, cliBody)
	}
	// The MCP fixture took ORBIT_HOME for a home of its own; the CLI reads its private one again.
	t.Setenv("ORBIT_HOME", home)

	// --json prints the structured answer alone.
	var jsonOut strings.Builder
	if err := cmdWikiCLI(append(append([]string{}, argv...), "--json"), strings.NewReader(""), &jsonOut); err != nil {
		t.Fatalf("orbit wiki draft --json: %v", err)
	}
	var decoded wikiDraftAnswer
	if err := json.Unmarshal([]byte(jsonOut.String()), &decoded); err != nil || decoded.DraftID != "d2" {
		t.Errorf("--json printed %q (%v)", jsonOut.String(), err)
	}

	// A section is doc/key; anything else is refused before it is sent, and --help is the command's own help.
	before := len(*requests)
	if err := cmdWikiCLI([]string{"draft", "--kind", "rewrite", "--section", "leases", "--reason", "r", "--idempotency-key", "k"}, strings.NewReader(""), &out); err == nil ||
		!strings.Contains(err.Error(), "must be doc/key") {
		t.Errorf("a section with no document was accepted: %v", err)
	}
	if len(*requests) != before {
		t.Errorf("a refused draft reached the server")
	}
	var help strings.Builder
	if err := cmdWikiCLI([]string{"draft", "--help"}, strings.NewReader(""), &help); err != nil || help.String() != wikiActionHelp["draft"] {
		t.Errorf("orbit wiki draft --help = %q (%v)", help.String(), err)
	}
	if !strings.Contains(help.String(), wikiDraftDescription) || !strings.Contains(wikiHelp, "orbit wiki draft") {
		t.Errorf("the help does not carry the tool's description, or the family's usage does not list draft")
	}
	args, err := wikiDraftToolArgs("rewrite", stringList{"a-doc/a-key"}, "r", "k", "")
	if err != nil || !reflect.DeepEqual(args["sections"], []interface{}{map[string]interface{}{"doc": "a-doc", "section": "a-key"}}) || args["replaces"] != nil {
		t.Errorf("wikiDraftToolArgs = %#v (%v)", args, err)
	}
}
