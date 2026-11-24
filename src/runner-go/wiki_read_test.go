package main

import (
	"net/http"
	"strings"
	"testing"
)

// wiki_read (contract `chat.read`, `agentSurface.chat.read`): a wiki chat's read of its wiki. The surface itself is
// TestWikiAgentSurfaceIsTheContracts'; this file holds what the tool says, sends and answers.

const wikiReadReply = `{"view":"doc","planVersion":3,"planDraft":null,"writerJobs":[],"text":"This is a view of the wiki, not a source.\nPlan version 3.","more":null}`

func TestWikiReadDescriptionIsTheContractsAndReadOnly(t *testing.T) {
	read := wikiSurface(t)["chat"].(map[string]interface{})["read"].(map[string]interface{})
	if got := read["description"].(string); wikiReadDescription != got {
		t.Fatalf("the description this binary ships is not the contract's:\n here: %q\n there: %q", wikiReadDescription, got)
	}
	descriptor := wikiDescriptor(t, "wiki_read")
	if descriptor["description"] != wikiReadDescription {
		t.Errorf("wiki_read's descriptor does not carry the contract's description")
	}
	annotations := descriptor["annotations"].(map[string]interface{})
	if annotations["readOnlyHint"] != true {
		t.Errorf("wiki_read is a read and says readOnlyHint = %v", annotations["readOnlyHint"])
	}
	if _, present := descriptor["outputSchema"]; !present {
		t.Errorf("wiki_read has no outputSchema")
	}
	if want := float64(wikiReadMaxChars); wikiContract(t)["chat"].(map[string]interface{})["rules"].(map[string]interface{})["readMaxChars"] != want {
		t.Errorf("readMaxChars is not %v in the contract", want)
	}
}

func TestWikiReadSendsOneGetAndAnswersTheServersText(t *testing.T) {
	srv, requests := wikiDoor(t, http.StatusOK, wikiReadReply)
	result := wikiMCP(t, srv.URL).callTool("wiki_read", map[string]interface{}{"doc": "sessions-runtime", "section": "leases"})
	if result["isError"] == true || !strings.Contains(wikiToolText(t, result), "not a source") {
		t.Fatalf("answer = %#v", result)
	}
	if result["structuredContent"] == nil {
		t.Errorf("no structured content")
	}
	if len(*requests) != 1 || (*requests)[0].method != http.MethodGet || (*requests)[0].session != "caller-session" ||
		(*requests)[0].uri != "/api/runner/wiki/read?doc=sessions-runtime&section=leases" {
		t.Errorf("requests = %#v", *requests)
	}
	// More than one of q, doc and draft, and a section with no doc, never leave the runner.
	for _, args := range []map[string]interface{}{{"q": "a", "doc": "b"}, {"section": "k"}} {
		srv2, requests2 := wikiDoor(t, http.StatusOK, wikiReadReply)
		if got := wikiMCP(t, srv2.URL).callTool("wiki_read", args); got["isError"] != true || len(*requests2) != 0 {
			t.Errorf("%v was sent or not refused: %#v", args, got)
		}
	}
}

func TestWikiReadRelaysRefusalsAndNamesAnOldServer(t *testing.T) {
	excluded := `{"code":"WIKI_SESSION_EXCLUDED","message":"wiki_read works only in a wiki chat: this session is no wiki chat."}`
	srv, _ := wikiDoor(t, http.StatusForbidden, excluded)
	text := wikiToolText(t, wikiMCP(t, srv.URL).callTool("wiki_read", map[string]interface{}{}))
	if !strings.Contains(text, "WIKI_SESSION_EXCLUDED") {
		t.Errorf("a session that is no chat was told %q", text)
	}
	old, _ := wikiDoor(t, http.StatusNotFound, `{"message":"Cannot GET /api/runner/wiki/read"}`)
	text = wikiToolText(t, wikiMCP(t, old.URL).callTool("wiki_read", map[string]interface{}{}))
	if !strings.Contains(text, "too old for wiki_read") {
		t.Errorf("an old server was reported as %q", text)
	}
}
