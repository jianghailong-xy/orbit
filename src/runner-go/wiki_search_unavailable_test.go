package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// A search from a workspace with no wiki answers 200 with no hits and `unavailable` (design §3.3,
// contract searchUnavailable). Each value is one sentence the agent reads, on the MCP door and on
// `orbit wiki search` alike, and neither reads as a search that found nothing.
func TestWikiSearchRendersUnavailable(t *testing.T) {
	for _, tc := range []struct{ unavailable, want string }{
		{"no_wiki", "No wiki for this repository yet, so there is nothing to look up. Carry on without it."},
		{"wiki_in_trash", "The wiki for this repository is in Trash: the owner restores it from Trash."},
	} {
		t.Run(tc.unavailable, func(t *testing.T) {
			reply := `{"q":"trgm index","semantic":false,"hits":[],"unavailable":"` + tc.unavailable + `"}`

			srv, _ := wikiDoor(t, http.StatusOK, reply)
			result := wikiMCP(t, srv.URL).callTool("wiki_search", map[string]interface{}{"query": "trgm index"})
			if result["isError"] == true {
				t.Fatalf("an unavailable wiki failed the call: %s", wikiToolText(t, result))
			}
			if text := wikiToolText(t, result); text != tc.want {
				t.Errorf("MCP text = %q, want %q", text, tc.want)
			}
			structured, _ := result["structuredContent"].(wikiSearchAnswer)
			if structured.Unavailable != tc.unavailable {
				t.Errorf("structuredContent.unavailable = %q, want %q", structured.Unavailable, tc.unavailable)
			}

			// The CLI's text is runWikiTool's Text, and its --json is the answer marshalled.
			srv, _ = wikiDoor(t, http.StatusOK, reply)
			answer, err := runWikiTool(NewTransport(srv.URL, "runner-token"), cliOrchestrationContext{sessionID: "caller-session"},
				"wiki_search", map[string]interface{}{"query": "trgm index"})
			if err != nil {
				t.Fatal(err)
			}
			if answer.Text != tc.want {
				t.Errorf("CLI text = %q, want %q", answer.Text, tc.want)
			}
			raw, _ := json.Marshal(answer.Data)
			if !strings.Contains(string(raw), `"unavailable":"`+tc.unavailable+`"`) {
				t.Errorf("CLI --json lost unavailable: %s", raw)
			}
		})
	}
}

// An answer without the field renders as it always has, and its JSON does not grow the field.
func TestWikiSearchWithoutUnavailableRendersAsBefore(t *testing.T) {
	query := wikiSearchQuery{Q: "nothing like it"}
	empty := describeWikiSearch(wikiSearchAnswer{Q: "nothing like it", Hits: []wikiSearchHit{}}, query)
	if want := "No entry in this space matches \"nothing like it\". Try other words, an alias, or a repo-relative path; " +
		"nothing was changed by this call."; empty != want {
		t.Errorf("empty search = %q, want %q", empty, want)
	}

	var answer wikiSearchAnswer
	if err := json.Unmarshal([]byte(wikiSearchReply), &answer); err != nil {
		t.Fatal(err)
	}
	text := describeWikiSearch(answer, wikiSearchQuery{Q: "trgm index"})
	if !strings.HasPrefix(text, "1 entry for \"trgm index\" (keyword and path recall; semantic search is off):\n") ||
		strings.Contains(text, "No wiki") || strings.Contains(text, "Trash") {
		t.Errorf("a search with hits renders differently:\n%s", text)
	}
	raw, _ := json.Marshal(answer)
	if strings.Contains(string(raw), "unavailable") {
		t.Errorf("an answer without unavailable now carries it: %s", raw)
	}
}

// The outputSchema declares `unavailable` with the contract's closed set, so an engine validating
// structuredContent accepts the answer.
func TestWikiSearchOutputSchemaDeclaresUnavailable(t *testing.T) {
	props := wikiDescriptor(t, "wiki_search")["outputSchema"].(map[string]interface{})["properties"].(map[string]interface{})
	field, ok := props["unavailable"].(map[string]interface{})
	if !ok {
		t.Fatalf("wiki_search's outputSchema does not declare unavailable: %#v", props)
	}
	enum, _ := field["enum"].([]string)
	contract, _ := wikiContract(t)["searchUnavailable"].(map[string]interface{})
	if len(enum) != len(contract) {
		t.Fatalf("unavailable enum = %v, contract searchUnavailable = %v", enum, contract)
	}
	for _, value := range enum {
		if _, ok := contract[value]; !ok {
			t.Errorf("unavailable %q is not in the contract's searchUnavailable", value)
		}
	}
}
