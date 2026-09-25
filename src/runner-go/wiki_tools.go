package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
)

// The Wiki tools (docs/wiki-design.md §5.2, contracts/wiki.contract.json `agentSurface`).
//
// An agent reads the wiki and proposes to it; it never decides. There is no accept, no confirm, no
// hard delete and no page overwrite here, and no tool that would be one: what an agent learned
// lands as a proposal that waits for the owner in Review. Three tools, split by risk rather than by
// entity — the two that only read say so, and the one that writes is the only one that changes what
// anyone can see.
//
// WHAT A SESSION MAY READ IS WHAT ITS WORKSPACE IS BOUND TO. The space comes from the calling
// session's own header on the server side (never from an argument here), so nothing a model writes
// can widen the reach of a call; a session reads the entries its bound workspace shares, plus the
// proposals it made itself and the owner has not decided.
//
// The same three verbs are `orbit wiki search|get|propose` (wiki_cli.go), which run the runWikiTool
// below: one implementation, two doors.

// The contract's limits, repeated so a schema states the bounds a request would be refused against.
const (
	wikiSearchLimitMax = 10
	wikiGetIDsMax      = 10
	wikiOpsPerTurn     = 5
)

// wikiEntryKinds is contracts/wiki.contract.json kinds, in the order the contract lists them. The
// reserved phase-3 kind (`assumption`) is not here: an agent may not propose one.
var wikiEntryKinds = []string{"principle", "convention", "decision", "pitfall", "recipe", "concept"}

// wikiOpNames is contracts/wiki.contract.json ops: the discriminated union wiki_propose takes.
var wikiOpNames = []string{"add", "reinforce", "amend", "supersede", "retire", "challenge"}

// wikiSearchMatches is contracts/wiki.contract.json searchMatches: the legs that can find an entry.
var wikiSearchMatches = []string{"keyword", "semantic", "path"}

// wikiIncludes is what wiki_get's include names, besides `none`.
var wikiIncludes = []string{"sources", "anchors", "history"}

// ── The one thing a proposal must be ────────────────────────────────────────────────────────────

// wikiProposePrecondition is contracts/wiki.contract.json `agentSurface.proposeDescription`, word
// for word, and wiki_tools_test.go holds the two equal. It leads the tool description because the
// failure it prevents is a model that reads the mechanics first: a proposal described by its fields
// reads like a write that happened, and the session tells the user it saved something that is
// waiting for review. So the precondition comes before any parameter, and says both halves — what
// is worth recording at all, and that recording it saves nothing.
const wikiProposePrecondition = "Record only what someone could not read from the code: a decision and what " +
	"was rejected, a pitfall and its fix, a convention. Cite the turns or records it came from; a claim you " +
	"cannot cite is not ready. What you propose waits for the owner's review — do not tell the user it is saved."

const wikiProposeDescription = wikiProposePrecondition + " This is how what you learned reaches the wiki: " +
	"ops[] is the batch, each op naming one of add / reinforce / amend / supersede / retire / challenge and " +
	"citing the sources it came from (a turn of this session is {kind:\"turn\",session:\"self\"}), with one " +
	"rationale for the batch and an idempotencyKey so a retry is not a second proposal. An op that applies " +
	"at once (a reinforce, a challenge, a kind the owner left auto-accepting) is recorded as applied; every " +
	"other waits as pending. What is recorded is a PROPOSAL either way: the owner reads it in Review and " +
	"accepts, edits or rejects it, so nothing here is knowledge yet, and nothing here reached any other " +
	"session. You cannot accept, confirm, delete or overwrite an entry: there is no tool that does, and the " +
	"owner's decision is the only door. Pass dryRun to have every op checked and answered as it would be, " +
	"recording nothing. Search first with wiki_search: a near neighbour is answered under similar[], and " +
	"reinforcing the entry that exists is better than adding a second one."

// ── The tool descriptors ────────────────────────────────────────────────────────────────────────

// wikiToolDescriptors is the agent-facing contract of the wiki tools. Unlike the task tools these
// are not gated on orchestration: reading what your own workspace shares and proposing what you
// learned is not a power over anybody else's session. They ARE gated on the wiki being on at all
// (wiki_rollout below), and every one of them carries an outputSchema and annotations: two declare
// themselves read-only, and the one that writes declares that it is not destructive — a proposal
// changes nothing the owner has not decided.
func wikiToolDescriptors(obj func(map[string]interface{}, ...string) map[string]interface{}) []map[string]interface{} {
	str := map[string]interface{}{"type": "string"}
	queryProp := map[string]interface{}{
		"type": "string",
		"description": "What to look for: words, or one repo-relative path (a path goes to the path leg, and " +
			"so do the entries whose anchors or pitfall triggers sit under it).",
	}
	kindsProp := map[string]interface{}{
		"type":        "array",
		"items":       map[string]interface{}{"type": "string", "enum": wikiEntryKinds},
		"description": "Only entries of these kinds.",
	}
	topicProp := map[string]interface{}{"type": "string", "description": "Only entries filed under this topic slug."}
	pathsProp := map[string]interface{}{
		"type":  "array",
		"items": str,
		"description": "Repo-relative paths: entries anchored or triggered under one of them are recalled by the " +
			"path leg, whether or not the query names them.",
	}
	limitProp := map[string]interface{}{
		"type":        "integer",
		"minimum":     1,
		"maximum":     wikiSearchLimitMax,
		"description": "How many entries to return at most, 1 to " + strconv.Itoa(wikiSearchLimitMax) + ".",
	}
	return []map[string]interface{}{
		{
			"name": "wiki_search",
			"description": "What the Orbit wiki already knows about this codebase, as entries: a keyword and path " +
				"search over titles, summaries, aliases and anchor paths. It returns entries and nothing else — id, " +
				"kind, title, summary, trust, anchorState, the legs that matched and a score — so read one in full " +
				"with wiki_get when the summary is not enough. Search BEFORE proposing: a near neighbour is better " +
				"reinforced than duplicated, and the answer to a proposal names what it resembles. A session reads " +
				"only the space its workspace is bound to, plus the proposals it made itself and the owner has not " +
				"decided yet; another session's pending proposal is not visible here.",
			"inputSchema": obj(map[string]interface{}{
				"query": queryProp,
				"kinds": kindsProp,
				"topic": topicProp,
				"paths": pathsProp,
				"limit": limitProp,
			}, "query"),
			"outputSchema": obj(map[string]interface{}{
				"q":        map[string]interface{}{"type": "string", "description": "The query as the server normalized it."},
				"semantic": map[string]interface{}{"type": "boolean", "description": "Whether a semantic leg ran. Off in phase 1."},
				"hits": map[string]interface{}{
					"type":        "array",
					"description": "The entries, best first. Empty when nothing matched.",
					"items": obj(map[string]interface{}{
						"id":          map[string]interface{}{"type": "string", "description": "The entry id, for wiki_get."},
						"kind":        map[string]interface{}{"type": "string", "enum": wikiEntryKinds},
						"title":       str,
						"summary":     map[string]interface{}{"type": "string", "description": "One sentence: the whole of what a card shows."},
						"trust":       map[string]interface{}{"type": "string", "enum": []string{"owner", "confirmed", "proposed", "external"}},
						"anchorState": map[string]interface{}{"type": "string", "enum": []string{"unchecked", "verified", "changed", "missing"}},
						"match": map[string]interface{}{
							"type":        "array",
							"items":       map[string]interface{}{"type": "string", "enum": wikiSearchMatches},
							"description": "Which legs found it: keyword, path, or (phase 2) semantic.",
						},
						"score": map[string]interface{}{"type": "number", "description": "The fused rank. Compare within one answer only."},
					}, "id", "kind", "title"),
				},
			}, "hits"),
			"annotations": map[string]interface{}{"readOnlyHint": true},
		},
		{
			"name": "wiki_get",
			"description": "Read whole wiki entries by id, as wiki_search returned them: the content, its anchors each " +
				"with the last check of it (the ref and when), and — with include: sources, the default — the records " +
				"it came from, each with the orbit-* link that reaches that record. Read the sources before you rely " +
				"on an entry and before you propose against it: a claim whose sources you cannot open is a claim you " +
				"cannot check. 1 to " + strconv.Itoa(wikiGetIDsMax) + " ids; an id this session may not read answers " +
				"under errors[] rather than failing the whole call.",
			"inputSchema": obj(map[string]interface{}{
				"ids": map[string]interface{}{
					"type":        "array",
					"minItems":    1,
					"maxItems":    wikiGetIDsMax,
					"items":       str,
					"description": "The entry ids to read, at most " + strconv.Itoa(wikiGetIDsMax) + ".",
				},
				"include": map[string]interface{}{
					"type":  "array",
					"items": map[string]interface{}{"type": "string", "enum": append(append([]string{}, wikiIncludes...), "none")},
					"description": "What each entry carries. sources (the default) adds the records it came from; history " +
						"adds every revision, and the door answers that with the sources too; anchors ride the entry and " +
						"are always there. none reads the entry alone, and cannot be combined with the others.",
				},
			}, "ids"),
			"outputSchema": obj(map[string]interface{}{
				"entries": map[string]interface{}{
					"type":        "array",
					"description": "The entries that were read, in the order they were asked for.",
					"items":       map[string]interface{}{"type": "object"},
				},
				"errors": map[string]interface{}{
					"type":        "array",
					"description": "Ids that could not be read, each with what the server said.",
					"items": obj(map[string]interface{}{
						"id":      str,
						"code":    map[string]interface{}{"type": "string", "description": "The refusal code, when the server gave one."},
						"message": str,
					}, "id", "message"),
				},
			}, "entries"),
			"annotations": map[string]interface{}{"readOnlyHint": true},
		},
		{
			"name":        "wiki_propose",
			"description": wikiProposeDescription,
			"inputSchema": obj(map[string]interface{}{
				"ops": map[string]interface{}{
					"type":     "array",
					"minItems": 1,
					"maxItems": wikiOpsPerTurn,
					"items": obj(map[string]interface{}{
						"op": map[string]interface{}{"type": "string", "enum": wikiOpNames},
						"entry": obj(map[string]interface{}{
							"kind":    map[string]interface{}{"type": "string", "enum": wikiEntryKinds},
							"title":   str,
							"summary": str,
							"fields":  map[string]interface{}{"type": "object", "description": "The kind's own fields; the server refuses WIKI_SCHEMA naming every one that failed."},
							"topics":  map[string]interface{}{"type": "array", "items": str},
							"aliases": map[string]interface{}{"type": "array", "items": str},
							"anchors": map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "object"}},
						}, "kind", "title", "summary", "fields"),
						"entryId":      map[string]interface{}{"type": "string", "description": "The entry the op is about: required by every op but add."},
						"baseRevision": map[string]interface{}{"type": "integer", "description": "The revision the op was written against, required by amend, supersede and retire and forbidden by the others."},
						"changes":      map[string]interface{}{"type": "object", "description": "amend: any of title, summary, fields, topics, aliases, anchors; a key given replaces that key whole, a key omitted carries over."},
						"reason":       map[string]interface{}{"type": "string", "description": "retire or challenge: why, in text; Review shows it beside the op."},
						"sources": map[string]interface{}{
							"type":        "array",
							"items":       map[string]interface{}{"type": "object"},
							"description": "The records this came from: {kind, ref|session, quote}. Reinforce requires at least one, and a quote must be a substring of the record it cites.",
						},
					}, "op"),
					"description": "The batch, at most " + strconv.Itoa(wikiOpsPerTurn) + " ops per turn, each answered on its own by its position.",
				},
				"rationale": map[string]interface{}{
					"type":        "string",
					"description": "Why this batch is worth recording, in text. Required, and shown to the owner in Review.",
				},
				"idempotencyKey": map[string]interface{}{
					"type":      "string",
					"minLength": 1,
					"maxLength": 200,
					"description": "Required, and yours to choose: the same key with the same request returns the recorded " +
						"answer instead of proposing again, so a retry after an answer you never saw is safe.",
				},
				"dryRun": map[string]interface{}{
					"type":        "boolean",
					"description": "Check every op and answer as the request would, recording nothing and publishing nothing.",
				},
			}, "ops", "rationale", "idempotencyKey"),
			"outputSchema": obj(map[string]interface{}{
				"changesetId": map[string]interface{}{
					"type":        []string{"string", "null"},
					"description": "The changeset this batch was recorded as; null when nothing was recorded (a dry run, or every op refused).",
				},
				"replayed": map[string]interface{}{"type": "boolean", "description": "True when this is the recorded answer to an earlier request under the same idempotencyKey."},
				"ops": map[string]interface{}{
					"type":        "array",
					"description": "One answer per op, by its 0-based position in the request.",
					"items": obj(map[string]interface{}{
						"seq":    map[string]interface{}{"type": "integer"},
						"status": map[string]interface{}{"type": "string", "enum": []string{"pending", "applied", "conflict", "refused"}},
						"opId":   map[string]interface{}{"type": []string{"string", "null"}},
						"entryId": map[string]interface{}{
							"type":        []string{"string", "null"},
							"description": "The entry the op is about; null on a dry run, which records nothing.",
						},
						"revision":        map[string]interface{}{"type": []string{"integer", "null"}, "description": "applied: the revision that was written."},
						"baseRevision":    map[string]interface{}{"type": "integer", "description": "conflict: the revision the op was written against."},
						"currentRevision": map[string]interface{}{"type": "integer", "description": "conflict: the revision the entry is at now."},
						"current":         map[string]interface{}{"type": "object", "description": "conflict: the entry's current content, as changes over the base."},
						"diff":            map[string]interface{}{"type": "string", "description": "conflict: what changed between the two revisions."},
						"reasons": map[string]interface{}{
							"type":        "array",
							"description": "refused: why, each with the contract's code.",
							"items": obj(map[string]interface{}{
								"code":    str,
								"message": str,
								"errors":  map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "object"}},
							}, "code", "message"),
						},
						"similar": map[string]interface{}{
							"type":        "array",
							"description": "add or supersede: the entries this one resembles, so a duplicate is visible before the owner sees it.",
							"items":       map[string]interface{}{"type": "object"},
						},
					}, "seq", "status"),
				},
			}, "ops"),
			// readOnlyHint false and destructiveHint false, both said out loud: a proposal writes,
			// and what it writes takes nothing away from anybody — the entry an amendment is about
			// keeps its revision until the owner decides, and a retire is the owner's to accept.
			// (design §5.2: wiki_propose carries no destructiveHint.)
			"annotations": map[string]interface{}{"readOnlyHint": false, "destructiveHint": false},
		},
	}
}

// wikiToolNames is the set callWikiTool answers for.
var wikiToolNames = map[string]bool{
	"wiki_search":  true,
	"wiki_get":     true,
	"wiki_propose": true,
}

// callWikiTool runs one wiki tool for the session this server runs in, and reports whether it
// handled the name.
func (s *mcpServer) callWikiTool(name string, args map[string]interface{}) (map[string]interface{}, bool) {
	if !wikiToolNames[name] {
		return nil, false
	}
	if s.wikiOff {
		return toolResult(wikiOffMessage(name), true), true
	}
	if strings.TrimSpace(s.sessionID) == "" {
		return toolResult(name+" reads and proposes as the session it is called from, and this MCP server is not "+
			"running inside one: the space it may read is the one the calling session's workspace is bound to", true), true
	}
	answer, err := runWikiTool(s.t, cliOrchestrationContext{sessionID: s.sessionID}, name, args)
	if err != nil {
		return toolResult(err.Error(), true), true
	}
	return toolResultWithData(answer.Text, answer.Data, false), true
}

// wikiAnswer is one tool's answer: the text fallback a model reads, and the structured content the
// tool's outputSchema describes. The MCP door sends both; `orbit wiki --json` prints Data alone.
type wikiAnswer struct {
	Text string
	Data interface{}
}

// toolResultWithData is toolResult plus the structured content an outputSchema promises. An error
// result carries none: there is no answer, and a schema-conforming empty object would read as one.
func toolResultWithData(text string, data interface{}, isErr bool) map[string]interface{} {
	result := toolResult(text, isErr)
	if data != nil && !isErr {
		result["structuredContent"] = data
	}
	return result
}

// runWikiTool runs one wiki tool for caller's session. Shared by `orbit mcp` and `orbit wiki`, so
// the two doors cannot answer differently.
func runWikiTool(t *Transport, caller cliOrchestrationContext, name string, args map[string]interface{}) (wikiAnswer, error) {
	switch name {
	case "wiki_search":
		query := wikiSearchQuery{
			Q:     strings.TrimSpace(getString(args, "query")),
			Topic: strings.TrimSpace(getString(args, "topic")),
			Paths: trimmed(getStringSlice(args, "paths")),
		}
		// A kind is named in lower case, and this is where the caller's spelling is settled: a
		// "Decision" accepted here and forwarded as written would match nothing, which reads as an
		// empty wiki rather than as a kind this door does not have.
		for i, kind := range getStringSlice(args, "kinds") {
			kind = strings.ToLower(strings.TrimSpace(kind))
			if !contains(wikiEntryKinds, kind) {
				return wikiAnswer{}, fmt.Errorf("kinds[%d] must be one of %s", i, strings.Join(wikiEntryKinds, ", "))
			}
			query.Kinds = append(query.Kinds, kind)
		}
		if query.Q == "" && len(query.Paths) == 0 {
			return wikiAnswer{}, fmt.Errorf("query is required: the words to look for, or a repo-relative path")
		}
		if args["limit"] != nil {
			limit, err := getBoundedOptionalNumber(args, "limit", wikiSearchLimitMax)
			if err != nil {
				return wikiAnswer{}, err
			}
			query.Limit = limit
		}
		raw, err := t.searchWiki(caller.sessionID, query)
		if err != nil {
			return wikiAnswer{}, wikiCallError("wiki_search", err)
		}
		var answer wikiSearchAnswer
		if err := json.Unmarshal(raw, &answer); err != nil {
			return wikiAnswer{}, fmt.Errorf("wiki_search: the server's answer is not the shape this build reads: %w", err)
		}
		return wikiAnswer{Text: describeWikiSearch(answer, query), Data: answer}, nil

	case "wiki_get":
		ids := uniqueStrings(trimmed(getStringSlice(args, "ids")))
		if len(ids) == 0 {
			return wikiAnswer{}, fmt.Errorf("ids is required: the entry ids to read, at most %d", wikiGetIDsMax)
		}
		if len(ids) > wikiGetIDsMax {
			return wikiAnswer{}, fmt.Errorf("ids takes at most %d entries, got %d: read them in two calls", wikiGetIDsMax, len(ids))
		}
		for _, id := range ids {
			if err := validatePathSegmentID(id); err != nil {
				return wikiAnswer{}, fmt.Errorf("ids: %q %w", id, err)
			}
		}
		include, err := wikiIncludeArg(args)
		if err != nil {
			return wikiAnswer{}, err
		}
		answer := wikiGetAnswer{Entries: []map[string]interface{}{}, Errors: []wikiReadError{}}
		for _, id := range ids {
			raw, err := t.getWikiEntry(caller.sessionID, id, include)
			if err != nil {
				// An id this session may not read is one answer among several: the other ids were
				// read, and the caller can tell a renamed entry from a door that is not there.
				if wikiEntryUnreadable(err) {
					answer.Errors = append(answer.Errors, wikiReadError{ID: id, Code: refusalCodeOf(err), Message: refusalMessageOf(err)})
					continue
				}
				return wikiAnswer{}, wikiCallError("wiki_get", err)
			}
			var entry map[string]interface{}
			if err := json.Unmarshal(raw, &entry); err != nil {
				return wikiAnswer{}, fmt.Errorf("wiki_get: the server's answer for %s is not the shape this build reads: %w", id, err)
			}
			answer.Entries = append(answer.Entries, entry)
		}
		return wikiAnswer{Text: describeWikiGet(answer), Data: answer}, nil

	case "wiki_propose":
		ops, err := wikiOpsArg(args["ops"])
		if err != nil {
			return wikiAnswer{}, err
		}
		if err := checkWikiOps(ops); err != nil {
			return wikiAnswer{}, err
		}
		body := map[string]interface{}{
			"ops":            ops,
			"rationale":      strings.TrimSpace(getString(args, "rationale")),
			"idempotencyKey": strings.TrimSpace(getString(args, "idempotencyKey")),
		}
		if body["rationale"] == "" {
			return wikiAnswer{}, fmt.Errorf("rationale is required: why this is worth recording, in one piece of text")
		}
		if body["idempotencyKey"] == "" {
			return wikiAnswer{}, fmt.Errorf("idempotencyKey is required: it is what makes a retry after an answer you " +
				"never saw return the recorded answer instead of proposing the same thing twice")
		}
		dryRun := false
		if value, ok := args["dryRun"].(bool); ok && value {
			body["dryRun"] = true
			dryRun = true
		}
		raw, err := t.proposeWikiChangeset(caller.sessionID, body)
		if err != nil {
			// A refused batch is an ANSWER, not a failed call: the door answers with the first
			// refusal's status and every op's outcome in the body, and that body is what the agent
			// has to read (per-op reasons, the current revision of a conflict).
			answer, answered := wikiProposeAnswerIn(err)
			if !answered {
				return wikiAnswer{}, wikiCallError("wiki_propose", err)
			}
			return wikiAnswer{Text: describeWikiPropose(answer, wikiOpNamesOf(ops), dryRun), Data: answer}, nil
		}
		var answer wikiProposeAnswer
		if err := json.Unmarshal(raw, &answer); err != nil {
			return wikiAnswer{}, fmt.Errorf("wiki_propose: the server's answer is not the shape this build reads: %w", err)
		}
		return wikiAnswer{Text: describeWikiPropose(answer, wikiOpNamesOf(ops), dryRun), Data: answer}, nil
	}
	return wikiAnswer{}, fmt.Errorf("unknown wiki tool %q", name)
}

// ── Arguments ───────────────────────────────────────────────────────────────────────────────────

// wikiSearchQuery is one search as the runner door takes it.
type wikiSearchQuery struct {
	Q     string
	Kinds []string
	Topic string
	Paths []string
	Limit int
}

// wikiSearchAnswer is `GET /api/runner/wiki/search` (contract `agentSurface.toolSpecs.wiki_search`).
type wikiSearchAnswer struct {
	Q        string          `json:"q"`
	Semantic bool            `json:"semantic"`
	Hits     []wikiSearchHit `json:"hits"`
}

// wikiSearchHit is one entry as the search ranked it, and no more than that: the legs that found it
// are the answer's own account of why it is here.
type wikiSearchHit struct {
	ID          string   `json:"id"`
	Kind        string   `json:"kind"`
	Title       string   `json:"title"`
	Summary     string   `json:"summary"`
	Trust       string   `json:"trust"`
	AnchorState string   `json:"anchorState"`
	Match       []string `json:"match"`
	Score       float64  `json:"score"`
}

// wikiGetAnswer is what wiki_get returns: the entries that were read, and the ids that were not.
type wikiGetAnswer struct {
	Entries []map[string]interface{} `json:"entries"`
	Errors  []wikiReadError          `json:"errors"`
}

// wikiReadError is one id the call could not read. The entry views are passed through whole — they
// are the server's own wire shape, and a build that re-listed their fields would drop the ones it
// has not heard of yet.
type wikiReadError struct {
	ID      string `json:"id"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message"`
}

// wikiProposeAnswer is `POST /api/runner/wiki/changesets` (contract `agentSurface.toolSpecs.wiki_propose`).
type wikiProposeAnswer struct {
	ChangesetID string                   `json:"changesetId"`
	Replayed    bool                     `json:"replayed"`
	Ops         []map[string]interface{} `json:"ops"`
}

// wikiOpsArg reads ops: an array of objects, or that array sent as a JSON string, which models do.
// What each op must contain is the server's to enforce — it answers WIKI_SCHEMA naming every field
// by path, which is a better refusal than this side could write.
func wikiOpsArg(raw interface{}) ([]interface{}, error) {
	switch value := raw.(type) {
	case nil:
		return nil, fmt.Errorf("ops is required: at least one op, each naming op as one of %s", strings.Join(wikiOpNames, ", "))
	case []interface{}:
		return value, nil
	case string:
		var parsed []interface{}
		if err := json.Unmarshal([]byte(strings.TrimSpace(value)), &parsed); err != nil {
			return nil, fmt.Errorf("ops must be a JSON array of ops: %v", err)
		}
		return parsed, nil
	}
	return nil, fmt.Errorf("ops must be an array of ops, each an object naming op as one of %s", strings.Join(wikiOpNames, ", "))
}

func checkWikiOps(ops []interface{}) error {
	if len(ops) == 0 {
		return fmt.Errorf("ops is required: at least one op, each naming op as one of %s", strings.Join(wikiOpNames, ", "))
	}
	if len(ops) > wikiOpsPerTurn {
		return fmt.Errorf("ops takes at most %d in one turn, got %d: propose the most important ones now", wikiOpsPerTurn, len(ops))
	}
	for i, raw := range ops {
		entry, ok := raw.(map[string]interface{})
		if !ok {
			return fmt.Errorf("ops[%d] must be an object naming op as one of %s", i, strings.Join(wikiOpNames, ", "))
		}
		if !contains(wikiOpNames, strings.TrimSpace(getString(entry, "op"))) {
			return fmt.Errorf("ops[%d].op must be one of %s", i, strings.Join(wikiOpNames, ", "))
		}
	}
	return nil
}

// wikiIncludeArg maps include onto the door's own parameter: it can be told to add the history, or
// to leave the sources out, and nothing finer.
func wikiIncludeArg(args map[string]interface{}) (string, error) {
	values := uniqueStrings(getStringSlice(args, "include"))
	if len(values) == 0 {
		return "", nil
	}
	wantSources, wantHistory := false, false
	for _, raw := range values {
		switch strings.ToLower(strings.TrimSpace(raw)) {
		case "sources":
			wantSources = true
		case "anchors":
			// Anchors ride the entry: they are readable whether or not they are named, so naming
			// them is a request this door already answers.
		case "history":
			wantHistory = true
		case "none":
			if len(values) > 1 {
				return "", fmt.Errorf("include none cannot be combined with %s", strings.Join(values, ", "))
			}
		default:
			return "", fmt.Errorf("include must name %s or none, not %q", strings.Join(wikiIncludes, ", "), raw)
		}
	}
	if wantHistory {
		return "all", nil
	}
	if !wantSources {
		return "none", nil
	}
	return "", nil
}

// wikiOpNamesOf is the op names of a request, by the position each is answered under.
func wikiOpNamesOf(ops []interface{}) []string {
	names := make([]string, 0, len(ops))
	for _, raw := range ops {
		entry, _ := raw.(map[string]interface{})
		names = append(names, strings.TrimSpace(getString(entry, "op")))
	}
	return names
}

// ── What the caller reads ───────────────────────────────────────────────────────────────────────

func describeWikiSearch(answer wikiSearchAnswer, query wikiSearchQuery) string {
	// What was asked, as the caller asked it: a search by path has no query words, and an answer
	// quoting "" would read as a search that lost its question.
	asked := query.Q
	if asked == "" {
		asked = strings.Join(query.Paths, ", ")
	}
	if len(answer.Hits) == 0 {
		return fmt.Sprintf("No entry in this space matches %q. Try other words, an alias, or a repo-relative path; "+
			"nothing was changed by this call.", asked)
	}
	var out strings.Builder
	fmt.Fprintf(&out, "%s for %q", wikiCount(len(answer.Hits), "entry", "entries"), asked)
	if !answer.Semantic {
		out.WriteString(" (keyword and path recall; semantic search is off)")
	}
	out.WriteString(":\n")
	for _, hit := range answer.Hits {
		fmt.Fprintf(&out, "  %s  %s  [%s · anchor %s · %s]  matched: %s\n",
			hit.ID, hit.Title, hit.Trust, hit.AnchorState, hit.Kind, strings.Join(hit.Match, ", "))
	}
	out.WriteString("Read one in full with wiki_get, and refer to it in a reply as [title](orbit-wiki:<id>).")
	return out.String()
}

func describeWikiGet(answer wikiGetAnswer) string {
	var out strings.Builder
	fmt.Fprintf(&out, "%s read", wikiCount(len(answer.Entries), "entry", "entries"))
	if len(answer.Errors) > 0 {
		fmt.Fprintf(&out, "; %s could not be", wikiCount(len(answer.Errors), "id", "ids"))
		for i, failure := range answer.Errors {
			if i > 0 {
				out.WriteString(",")
			}
			fmt.Fprintf(&out, " %s (%s)", failure.ID, strings.TrimSpace(failure.Code+" "+failure.Message))
		}
	}
	out.WriteString(".\n")
	body, err := json.MarshalIndent(answer, "", "  ")
	if err != nil {
		return out.String()
	}
	out.Write(body)
	return out.String()
}

// describeWikiPropose says what happened to the batch in the terms that decide what the agent is
// allowed to say about it: a proposal is not knowledge, and only the owner can turn it into any.
func describeWikiPropose(answer wikiProposeAnswer, names []string, dryRun bool) string {
	var out strings.Builder
	switch {
	case dryRun:
		out.WriteString("Dry run: every op was checked, and NOTHING was recorded — no other session, and no owner, has seen any of this.\n")
	case answer.Replayed:
		fmt.Fprintf(&out, "This request was already recorded under this idempotencyKey, and this is that answer; nothing was proposed twice. Changeset %s.\n", answer.ChangesetID)
	case answer.ChangesetID == "":
		out.WriteString("Nothing was recorded: every op was refused. The reasons below are the whole answer.\n")
	default:
		fmt.Fprintf(&out, "Recorded as a proposal for the owner's review: changeset %s. It is not saved: the owner "+
			"decides in Review, and until they do, no other session reads it and nothing here is knowledge.\n", answer.ChangesetID)
	}
	for _, op := range answer.Ops {
		out.WriteString("  " + describeWikiOp(op, names))
		out.WriteString("\n")
	}
	if len(answer.Ops) > 0 {
		out.WriteString("Report this as a proposal waiting for review, never as a saved entry.\n")
	}
	return out.String()
}

func describeWikiOp(op map[string]interface{}, names []string) string {
	seq := -1
	if value, ok := op["seq"].(float64); ok {
		seq = int(value)
	}
	name := ""
	if seq >= 0 && seq < len(names) {
		name = names[seq]
	}
	label := fmt.Sprintf("op %d", seq)
	if name != "" {
		label += " " + name
	}
	status, _ := op["status"].(string)
	line := label + ": "
	switch status {
	case "pending":
		line += "pending — waiting for the owner's review"
	case "applied":
		line += "applied"
		if revision, ok := op["revision"].(float64); ok {
			line += fmt.Sprintf(" (now revision %d)", int(revision))
		}
	case "conflict":
		line += "conflict — the entry moved"
		if base, ok := op["baseRevision"].(float64); ok {
			if current, ok := op["currentRevision"].(float64); ok {
				line += fmt.Sprintf(" (written against revision %d, which is now %d)", int(base), int(current))
			}
		}
		line += ": read the entry again with wiki_get and propose against its current revision"
	case "refused":
		line += "refused"
		for _, reason := range wikiMapSlice(op["reasons"]) {
			code, _ := reason["code"].(string)
			message, _ := reason["message"].(string)
			line += " " + strings.TrimSpace(code+": "+message)
		}
	default:
		line += strings.TrimSpace(status)
	}
	if similar := wikiMapSlice(op["similar"]); len(similar) > 0 {
		parts := make([]string, 0, len(similar))
		for _, neighbour := range similar {
			id, _ := neighbour["id"].(string)
			title, _ := neighbour["title"].(string)
			parts = append(parts, strings.TrimSpace(id+" "+title))
		}
		line += "; similar: " + strings.Join(parts, " | ")
	}
	return line
}

func wikiMapSlice(raw interface{}) []map[string]interface{} {
	items, _ := raw.([]interface{})
	out := make([]map[string]interface{}, 0, len(items))
	for _, item := range items {
		if entry, ok := item.(map[string]interface{}); ok {
			out = append(out, entry)
		}
	}
	return out
}

// wikiCount is a count and its noun, with the irregular plural the noun needs.
func wikiCount(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return strconv.Itoa(n) + " " + many
}

// ── A refused batch is an answer ────────────────────────────────────────────────────────────────

// wikiProposeAnswerIn reads the answer out of a refusal: the door answers a batch none of whose ops
// was recorded with the first refusal's status and EVERY op's outcome in the body, so a 4xx here is
// the answer rather than a transport failure. A refusal with no ops in it — the wiki switched off,
// a session excluded from knowledge work, a space that is not bound — is not an answer and stays an
// error.
func wikiProposeAnswerIn(err error) (wikiProposeAnswer, bool) {
	var httpErr *transportHTTPError
	if !errors.As(err, &httpErr) {
		return wikiProposeAnswer{}, false
	}
	var answer wikiProposeAnswer
	if json.Unmarshal([]byte(httpErr.body), &answer) != nil || answer.Ops == nil {
		return wikiProposeAnswer{}, false
	}
	return answer, true
}

// ── The rollout switch (docs/wiki-design.md §5.2) ───────────────────────────────────────────────

// ORBIT_WIKI is the wiki's rollout flag as a session sees it. The apiserver decides per account
// whether the wiki is on and says so on every claim (`wikiDisabled`); the runner writes that into
// the engine's environment, and `orbit mcp` and `orbit wiki` read it from there. The server's own
// vocabulary is off | canary | drain | on and lives in ITS ORBIT_WIKI; what reaches a session is the
// resolved boolean, so only off and on are written here. A spawn reads the flag once, so an engine
// started before the flag changed keeps what it was started with until it is spawned again.
const envWiki = "ORBIT_WIKI"

// wikiDisabledCode is the code the control plane refuses a wiki request with while the wiki is not
// on for the account. It comes with a 404, the status a control plane without the wiki door answers
// too — which is why the two are told apart below by the code in the body.
const wikiDisabledCode = "WIKI_DISABLED"

// wikiEnv renders the ORBIT_WIKI value the runner injects at spawn.
func wikiEnv(disabled bool) string {
	if disabled {
		return "off"
	}
	return "on"
}

// wikiEnabledFromEnv reads ORBIT_WIKI. Only an explicit off turns the wiki off: a runner that
// predates the flag injects nothing, and its sessions keep what that runner always did.
func wikiEnabledFromEnv() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(envWiki))) {
	case "off", "0", "false", "no":
		return false
	default:
		return true
	}
}

// wikiDisabledByServer reports a control plane that has the wiki switched off for this account.
func wikiDisabledByServer(err error) bool {
	var httpErr *transportHTTPError
	return errors.As(err, &httpErr) && httpErr.statusCode == http.StatusNotFound && httpErr.code() == wikiDisabledCode
}

// wikiOffMessage is what a wiki tool or command answers in a session spawned with the wiki off.
func wikiOffMessage(what string) string {
	return what + ": the Orbit wiki is switched off for this session on this Orbit server (ORBIT_WIKI=off), so " +
		"there is nothing to read and nowhere to propose. Work from the code and what the user tells you, and look " +
		"again in a later session."
}

// withoutWikiTools is tools without the wiki tools: what `orbit mcp` lists when the wiki is off.
func withoutWikiTools(tools []map[string]interface{}) []map[string]interface{} {
	kept := make([]map[string]interface{}, 0, len(tools))
	for _, tool := range tools {
		if name, _ := tool["name"].(string); wikiToolNames[name] {
			continue
		}
		kept = append(kept, tool)
	}
	return kept
}

// ── Errors, in words ────────────────────────────────────────────────────────────────────────────

// wikiDoorMissing reports a control plane that predates the runner wiki door: this binary can be
// newer than the server it talks to. A route Nest does not have answers 404 as well, so the door's
// OWN 404s are told apart from it — a body carrying a wiki refusal code is the door answering on
// purpose, and "no such wiki entry" is the read door saying the id names nothing this session may
// read. What is left is a 404 that names no wiki thing at all.
func wikiDoorMissing(err error) bool {
	var httpErr *transportHTTPError
	if !errors.As(err, &httpErr) || httpErr.statusCode != http.StatusNotFound {
		return false
	}
	if !strings.HasPrefix(httpErr.path, "/runner/wiki") || httpErr.code() != "" {
		return false
	}
	return !strings.Contains(httpErr.body, "no such wiki entry")
}

// wikiEntryUnreadable reports the read door's own 404 for one id: the entry is not there, or it is
// not one this session may read, which is deliberately the same answer (contract
// `refusalRules.notFound`). The call can go on with the other ids.
func wikiEntryUnreadable(err error) bool {
	var httpErr *transportHTTPError
	if !errors.As(err, &httpErr) || httpErr.statusCode != http.StatusNotFound {
		return false
	}
	return !wikiDoorMissing(err) && !wikiDisabledByServer(err)
}

// wikiCallError says what failed. For a server without the door it says so in words, and for a wiki
// that is off it says that instead: both are 404s, and a bare one reads like a missing entry.
func wikiCallError(action string, err error) error {
	// Before the missing door: a server that has the wiki off answers 404 on purpose.
	if wikiDisabledByServer(err) {
		return fmt.Errorf("%s: the Orbit wiki is not switched on for this account on this Orbit server (%s). Nothing "+
			"was read and nothing was proposed; carry on without it, or tell the user", action, wikiDisabledCode)
	}
	if wikiDoorMissing(err) {
		return fmt.Errorf("%s: this Orbit server has no wiki door for agents yet (it answered 404 for /api/runner/wiki), "+
			"so nothing can be read or proposed. Upgrade the Orbit server; until then work from the code and tell the "+
			"user what you learned", action)
	}
	return fmt.Errorf("%s: %w", action, err)
}

// refusalCodeOf and refusalMessageOf pull a wiki refusal's code and sentence out of a response the
// transport wrapped, so one id's failure can be shown beside the ids that were read.
func refusalCodeOf(err error) string {
	var httpErr *transportHTTPError
	if !errors.As(err, &httpErr) {
		return ""
	}
	return httpErr.code()
}

func refusalMessageOf(err error) string {
	var httpErr *transportHTTPError
	if !errors.As(err, &httpErr) {
		return err.Error()
	}
	var body struct {
		Message string `json:"message"`
	}
	if json.Unmarshal([]byte(httpErr.body), &body) == nil && body.Message != "" {
		return body.Message
	}
	return strings.TrimSpace(httpErr.body)
}

// ── Transport ───────────────────────────────────────────────────────────────────────────────────

// searchWiki, getWikiEntry and proposeWikiChangeset live in transport.go with the other ops; the
// header these calls carry is the calling session's, which is what the door resolves the space from.
