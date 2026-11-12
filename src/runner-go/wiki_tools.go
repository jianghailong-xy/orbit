package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// The Wiki tools (docs/wiki-design.md §5.2, contracts/wiki.contract.json `agentSurface`).
//
// An agent reads the wiki and proposes to it; it never decides. There is no accept, no confirm, no
// hard delete and no page overwrite here, and no tool that would be one: what an agent learned goes
// through the space's review mode, which decides whether it waits or is live. Five tools, split by
// risk rather than by entity — the two that only read say so, the one that proposes changes what
// anyone can see, and wiki_note only leaves a claim for maintenance to check, unless it corrects an
// entry, which flags it at once. The fifth, wiki_draft, is a wiki chat's alone (contract
// `agentSurface.chat.draft`): it makes a card the chat's owner may press, and the server refuses it to
// every other session. In a wiki chat wiki_propose and a wiki_note's corrects make cards too, and
// nothing of the wiki changes until the owner presses one.
//
// WHAT A SESSION MAY READ IS WHAT ITS WORKSPACE IS BOUND TO. The space comes from the calling
// session's own header on the server side (never from an argument here), so nothing a model writes
// can widen the reach of a call; a session reads the entries its bound workspace shares, plus the
// proposals it made itself and the owner has not decided.
//
// The same five verbs are `orbit wiki search|get|propose|note|draft` (wiki_cli.go), which run the runWikiTool
// below: one implementation, two doors.

// The contract's limits, repeated so a schema states the bounds a request would be refused against.
const (
	wikiSearchLimitMax = 10
	wikiGetIDsMax      = 10
	wikiOpsPerTurn     = 5
	// contracts/wiki.contract.json agentSurface.note.rules.
	wikiNoteTextMaxChars = 2000
	wikiNotePathsMax     = 10
	wikiNotePathMaxChars = 200
	// contracts/wiki.contract.json chat.rules.rewritesMax: the most sections one card rewrites.
	wikiDraftSectionsMax = 5
)

// wikiDraftKinds is what wiki_draft drafts (contract `agentSurface.chat.draft.params.kind`): a rewrite of sections from
// main, or a plan change (the plan card, C12), whose change is the documents as they should read — several in one card
// since C17, so a split is one card.
var wikiDraftKinds = []string{"rewrite", "plan"}

// wikiEntryKinds is contracts/wiki.contract.json kinds, in the order the contract lists them. The
// reserved phase-3 kind (`assumption`) is not here: an agent may not propose one.
var wikiEntryKinds = []string{"principle", "convention", "decision", "pitfall", "recipe", "concept"}

// wikiOpNames is contracts/wiki.contract.json ops: the discriminated union wiki_propose takes.
var wikiOpNames = []string{"add", "reinforce", "amend", "supersede", "retire", "challenge"}

// wikiSearchMatches is contracts/wiki.contract.json searchMatches: the legs that can find an entry.
var wikiSearchMatches = []string{"keyword", "semantic", "path"}

// wikiSearchUnavailable is contracts/wiki.contract.json searchUnavailable: why a search had no wiki to read.
var wikiSearchUnavailable = []string{"no_wiki", "wiki_in_trash"}

// wikiTrustLevels is contracts/wiki.contract.json trust.values, in its order: what a hit's trust can
// say. `auto` and `unreviewed` are what a space's review mode leaves an entry it applied at once, and
// an output schema that did not name them would call a correct answer malformed.
var wikiTrustLevels = []string{"owner", "confirmed", "auto", "unreviewed", "proposed", "external"}

// wikiIncludes is what wiki_get's include names, besides `none`.
var wikiIncludes = []string{"sources", "anchors", "history"}

// ── The one thing a proposal must be ────────────────────────────────────────────────────────────

// wikiProposePrecondition is contracts/wiki.contract.json `agentSurface.proposeDescription`, word
// for word, and wiki_tools_test.go holds the two equal. It leads the tool description because the
// failure it prevents is a model that reads the mechanics first: a proposal described by its fields
// reads like a write that happened, and the session tells the user it saved something that is
// waiting. So the precondition comes before any parameter, and says both halves — what is worth
// recording at all, and that what recording it does depends on the space (contract `reviewModes`).
// It used to say every proposal waits for the owner, which only a Manual space does.
const wikiProposePrecondition = "Record only what someone could not read from the code: a decision and what " +
	"was rejected, a pitfall and its fix, a convention. Cite the turns or records it came from; a claim you " +
	"cannot cite is not ready. Whether it takes effect depends on the space's review mode, and what has taken " +
	"effect other sessions can find in a search: tell the user what each op's status says, and never call a " +
	"pending op saved."

const wikiProposeDescription = wikiProposePrecondition + " This is how what you learned reaches the wiki: " +
	"ops[] is the batch, each op naming one of add / reinforce / amend / supersede / retire / challenge and " +
	"citing the sources it came from (a turn of this session is {kind:\"turn\",session:\"self\"}), with one " +
	"rationale for the batch and an idempotencyKey so a retry is not a second proposal. Each op answers with " +
	"its status. applied: it is live now, and other sessions of this space can find it; a challenge always " +
	"is, a reinforce unless the space holds reinforces back, and in a Tiered space most adds and amends. " +
	"pending: it is not live. In a Manual space it waits for the owner in Review; in an Automatic space a " +
	"verification reads the sources it cites and its verdict decides (waitsFor says so); a supersede or a " +
	"retire waits for the owner in every mode. The owner can still reject or revert what went live. You " +
	"cannot accept, confirm or delete an entry: there is no tool that does. Pass dryRun to have every op " +
	"checked and answered as it would be, recording nothing. Search first with wiki_search: a near neighbour " +
	"is answered under similar[], and reinforcing the entry that exists is better than adding a second one."

// wikiNoteDescription is contracts/wiki.contract.json `agentSurface.noteDescription`, word for word, and
// wiki_tools_test.go holds the two equal (docs/wiki-memory-claims-design.md section 4). It says first that this
// is not in the wiki yet: a note is a claim the next maintenance run checks, and a session that took it for a
// saved entry would tell the user something untrue.
const wikiNoteDescription = "Tell the wiki something this session learned that someone could not read from the code: " +
	"a decision and why, a trap and its fix, a rule the owner gave. One claim, in one or two sentences. Maintenance " +
	"reads it later against this session's records and writes an entry only if they bear it out, so it is not in the " +
	"wiki yet and may never be. Not for progress or status: use task_progress_report. If your engine keeps its own " +
	"memory, what you write there is read the same way: do not write both. To say an entry is wrong, pass corrects " +
	"with its id: the entry is flagged at once."

// wikiDraftDescription is contracts/wiki.contract.json `agentSurface.chat.draft.description`, word for word, and
// wiki_tools_test.go holds the two equal. It says first that nothing is written until the owner presses the card, and
// last that it works only in a wiki chat, which the server enforces for every other session (WIKI_SESSION_EXCLUDED).
const wikiDraftDescription = "Draft, for the owner of this wiki chat to apply, a change that is not an entry: a rewrite of " +
	"wiki sections from main, when the code changed and a section did not follow it, or a change to how the wiki's " +
	"documents are planned. Nothing is written until the owner presses Apply on the card, so never call a draft applied. " +
	"A change to what the wiki knows is an entry: use wiki_propose. Works only in a wiki chat."

// wikiReplacesDescription is what the `replaces` parameter of the three drafting tools says (contract
// `agentSurface.chat.replaces`).
const wikiReplacesDescription = "In a wiki chat only: the id of an open card of this chat that this one replaces, " +
	"when you revise a draft. The card it names reads Replaced from then on. Any other session leaves it unread."

// wikiSourceRefs is what each source kind takes as its ref (contracts/wiki.contract.json
// `sourceInput.refs`), said where a source is filled in: a tool_use_id where a row's id goes is the
// mistake it prevents, because task_evidence_submit takes exactly that id for a tool call.
// wiki_tools_test.go holds it to naming every kind the contract lists.
const wikiSourceRefs = "ref by kind: turn, event, task, task_comment, approval, merge_receipt and note take the " +
	"record's id (its UUID, or the short id Orbit shows); owner_decision the id of the project blocker the owner " +
	"resolved with a note; tool_call the tool call's id, or the tool_use_id its engine gave the call (toolu_…, " +
	"call_…), this session's own call first and else the one session of the owner's that made it; commit the full " +
	"sha. evidence, criterion and url cannot be cited yet. A turn of this session is {kind:\"turn\",session:\"self\"} " +
	"and takes no ref. A ref that names nothing is refused, naming the source as ops[i].sources[j].ref."

// ── The tool descriptors ────────────────────────────────────────────────────────────────────────

// wikiToolDescriptors is the agent-facing contract of the wiki tools. Unlike the task tools these
// are not gated on orchestration: reading what your own workspace shares and proposing what you
// learned is not a power over anybody else's session. They ARE gated on the wiki being on at all
// (wiki_rollout below), and every one of them carries an outputSchema and annotations: two declare
// themselves read-only, and the one that writes declares that it is not destructive — it keeps every
// revision, and what ends a lineage waits for the owner.
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
				"kind, title, summary, trust, anchorState, the legs that matched, a score, and how old each one is: " +
				"when it was recorded, when its current revision was written, and the commit and time its anchors were " +
				"last checked at — so read one in full with wiki_get when the summary is not enough. A verified anchor " +
				"was found as recorded, which does not say the entry still holds: weigh an old one against the code. " +
				"Search BEFORE proposing: a near neighbour is better " +
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
						"trust":       map[string]interface{}{"type": "string", "enum": wikiTrustLevels},
						"anchorState": map[string]interface{}{"type": "string", "enum": []string{"unchecked", "verified", "changed", "missing"}},
						"match": map[string]interface{}{
							"type":        "array",
							"items":       map[string]interface{}{"type": "string", "enum": wikiSearchMatches},
							"description": "Which legs found it: keyword, path, or (phase 2) semantic.",
						},
						"score": map[string]interface{}{"type": "number", "description": "The fused rank. Compare within one answer only."},
						// How old the entry is (contract `agentSurface.toolSpecs.wiki_search.age`). Each is left
						// out where the server sent none: a check not made yet, or a server that predates them.
						"recordedAt": map[string]interface{}{"type": "string", "description": "When the entry was first recorded, ISO 8601 in UTC. No amend moves it."},
						"changedAt":  map[string]interface{}{"type": "string", "description": "When its current revision was written, ISO 8601 in UTC: the last change to what it says."},
						"anchorCheckedRef": map[string]interface{}{"type": "string",
							"description": "The commit its anchors were last checked at. Absent until a check; it can be older than changedAt."},
						"anchorCheckedAt": map[string]interface{}{"type": "string",
							"description": "When that check was made, ISO 8601 in UTC. A check finds the anchors as recorded or not; it does not re-read what the entry says."},
					}, "id", "kind", "title"),
				},
				"unavailable": map[string]interface{}{
					"type":        "string",
					"enum":        wikiSearchUnavailable,
					"description": "Present only when there was no wiki to search: no_wiki (this repository has none) or wiki_in_trash (its wiki is in Trash). hits is then empty.",
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
						"entryId":          map[string]interface{}{"type": "string", "description": "The entry the op is about: required by every op but add."},
						"baseRevision":     map[string]interface{}{"type": "integer", "description": "The revision the op was written against, required by amend, supersede and retire and forbidden by the others."},
						"changes":          map[string]interface{}{"type": "object", "description": "amend: any of title, summary, fields, topics, aliases, anchors; a key given replaces that key whole, a key omitted carries over."},
						"answersChallenge": map[string]interface{}{"type": "string", "description": "amend, optional: the id of a pending challenge op of this very entry. When the amend takes effect it closes that challenge, and the entry returns to the push if nothing else holds it out — the id is the challenge's opId, and an amend that names none closes none."},
						"reason":           map[string]interface{}{"type": "string", "description": "retire or challenge: why, in text; Review shows it beside the op."},
						"sources": map[string]interface{}{
							"type":        "array",
							"items":       map[string]interface{}{"type": "object"},
							"description": "The records this came from: {kind, ref|session, quote}. Reinforce requires at least one, and a quote must be a substring of the record it cites. " + wikiSourceRefs,
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
				"replaces": map[string]interface{}{"type": "string", "description": wikiReplacesDescription},
			}, "ops", "rationale", "idempotencyKey"),
			"outputSchema": obj(map[string]interface{}{
				"changesetId": map[string]interface{}{
					"type":        []string{"string", "null"},
					"description": "The changeset this batch was recorded as; null when nothing was recorded (a dry run, or every op refused).",
				},
				"replayed": map[string]interface{}{"type": "boolean", "description": "True when this is the recorded answer to an earlier request under the same idempotencyKey."},
				// A wiki chat's answer (contract `agentSurface.chat.propose`): one card the owner may press, nothing written.
				"status":  map[string]interface{}{"type": "string", "enum": []string{"draft"}, "description": "In a wiki chat: draft — the ops that passed are one card for the owner to apply, and nothing of the wiki changed."},
				"draftId": map[string]interface{}{"type": "string", "description": "In a wiki chat: the card the ops that passed became. Pass it as replaces when you revise it."},
				"similar": map[string]interface{}{
					"type":        "array",
					"description": "In a wiki chat: the entries the card's adds and supersedes resemble, shown on the card before the press.",
					"items":       map[string]interface{}{"type": "object"},
				},
				"rewrites": map[string]interface{}{
					"type":        "array",
					"description": "In a wiki chat: the sections the card's press would rewrite, each with where it is and its title.",
					"items":       map[string]interface{}{"type": "object"},
				},
				"ops": map[string]interface{}{
					"type":        "array",
					"description": "One answer per op, by its 0-based position in the request.",
					"items": obj(map[string]interface{}{
						"seq":    map[string]interface{}{"type": "integer"},
						"status": map[string]interface{}{"type": "string", "enum": []string{"pending", "applied", "conflict", "refused", "draft"}},
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
			// keeps its earlier revisions, and a retire is the owner's to accept.
			// (design §5.2: wiki_propose carries no destructiveHint.)
			"annotations": map[string]interface{}{"readOnlyHint": false, "destructiveHint": false},
		},
		{
			"name":        "wiki_note",
			"description": wikiNoteDescription,
			"inputSchema": obj(map[string]interface{}{
				"text": map[string]interface{}{
					"type":        "string",
					"maxLength":   wikiNoteTextMaxChars,
					"description": "The claim, in one or two sentences, at most " + strconv.Itoa(wikiNoteTextMaxChars) + " characters.",
				},
				"paths": map[string]interface{}{
					"type":        "array",
					"maxItems":    wikiNotePathsMax,
					"items":       map[string]interface{}{"type": "string", "maxLength": wikiNotePathMaxChars},
					"description": "Repo-relative paths the claim is about, at most " + strconv.Itoa(wikiNotePathsMax) + ": they are kept with its text, and help maintenance find the records that bear on it.",
				},
				"corrects": map[string]interface{}{
					"type":        "string",
					"description": "The id of an entry this says is wrong, as wiki_search returned it. The entry is flagged at once, and the owner answers the flag in Review. In a wiki chat the flag is a card the owner may apply instead.",
				},
				"replaces": map[string]interface{}{"type": "string", "description": wikiReplacesDescription},
			}, "text"),
			"outputSchema": obj(map[string]interface{}{
				"noted":   map[string]interface{}{"type": "boolean", "description": "True: the claim is kept. It is not in the wiki."},
				"noteId":  map[string]interface{}{"type": "string", "description": "The note the claim is kept as."},
				"created": map[string]interface{}{"type": "boolean", "description": "False when the space already held this text, so nothing new was written."},
				"readBy":  map[string]interface{}{"type": "string", "description": "What reads the note against the session's records, in the server's words."},
				"challenged": obj(map[string]interface{}{
					"status":      map[string]interface{}{"type": "string", "enum": []string{"applied", "pending", "refused", "draft"}, "description": "refused: the entry is not flagged, and reasons say why. draft, in a wiki chat: the flag is a card for the owner to apply, and the entry is not flagged yet. Anything else: it is flagged. The note is kept either way."},
					"draftId":     map[string]interface{}{"type": "string", "description": "draft: the card the flag became."},
					"changesetId": map[string]interface{}{"type": []string{"string", "null"}},
					"opId":        map[string]interface{}{"type": []string{"string", "null"}},
					"entryId":     map[string]interface{}{"type": []string{"string", "null"}},
					"reasons":     map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "object"}},
				}, "status"),
			}, "noted", "noteId", "created", "readBy"),
			// It keeps a claim, and at most flags an entry for the owner to answer: nothing is taken away.
			"annotations": map[string]interface{}{"readOnlyHint": false, "destructiveHint": false},
		},
		{
			"name":        "wiki_draft",
			"description": wikiDraftDescription,
			"inputSchema": obj(map[string]interface{}{
				"kind": map[string]interface{}{
					"type":        "string",
					"enum":        wikiDraftKinds,
					"description": "rewrite: these sections lag behind main and are written again from it. plan: a change to how documents are planned or written — one or several in one card — sent as change.",
				},
				"sections": map[string]interface{}{
					"type":     "array",
					"minItems": 1,
					"maxItems": wikiDraftSectionsMax,
					"items": obj(map[string]interface{}{
						"doc":     map[string]interface{}{"type": "string", "description": "The document's slug, as the page and its attachments name it."},
						"section": map[string]interface{}{"type": "string", "description": "The section's key."},
					}, "doc", "section"),
					"description": "rewrite: 1 to " + strconv.Itoa(wikiDraftSectionsMax) + " written sections of the confirmed plan, each { doc, section }.",
				},
				"change": map[string]interface{}{"type": "object", "description": "plan: the change, { docs, categories? } — docs, each document " +
					"whole as it should read (the plan page attaches one), one of the plan's by its slug or a new one; categories, the ones " +
					"it opens that the plan does not have. One card changes several documents at once: to split a document, send it without " +
					"the sections that move and a new document holding them. A writing requirement goes into the covers of the sections it " +
					"is for: the writer reads covers, so the next rewrite keeps it."},
				"reason": map[string]interface{}{
					"type":        "string",
					"description": "Why, in a sentence or two: what lags behind main, or what the plan should do. The card shows it.",
				},
				"replaces": map[string]interface{}{"type": "string", "description": wikiReplacesDescription},
				"idempotencyKey": map[string]interface{}{
					"type":        "string",
					"minLength":   1,
					"maxLength":   200,
					"description": "Required, and yours to choose: the same key with the same request answers with the card it made.",
				},
			}, "kind", "reason", "idempotencyKey"),
			"outputSchema": obj(map[string]interface{}{
				"status":   map[string]interface{}{"type": "string", "enum": []string{"draft"}, "description": "draft: a card for the owner to press; nothing was written."},
				"draftId":  map[string]interface{}{"type": "string", "description": "The card. Pass it as replaces when you revise it."},
				"kind":     map[string]interface{}{"type": "string", "enum": wikiDraftKinds},
				"replayed": map[string]interface{}{"type": "boolean", "description": "True when this is the card an earlier call under the same idempotencyKey made."},
				"rewrites": map[string]interface{}{
					"type":        "array",
					"description": "The sections the press would rewrite, each with where it is and its title.",
					"items":       map[string]interface{}{"type": "object"},
				},
			}, "status", "draftId", "kind"),
			// It makes a card and nothing else: no accept, no confirm, no page overwritten (contract `notTools`).
			"annotations": map[string]interface{}{"readOnlyHint": false, "destructiveHint": false},
		},
	}
}

// wikiToolNames is the set callWikiTool answers for.
var wikiToolNames = map[string]bool{
	"wiki_search":  true,
	"wiki_get":     true,
	"wiki_propose": true,
	"wiki_note":    true,
	"wiki_draft":   true,
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
		if replaces := strings.TrimSpace(getString(args, "replaces")); replaces != "" {
			body["replaces"] = replaces
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

	case "wiki_note":
		body, err := wikiNoteBody(args)
		if err != nil {
			return wikiAnswer{}, err
		}
		raw, err := t.writeWikiNote(caller.sessionID, body)
		if err != nil {
			return wikiAnswer{}, wikiNoteCallError(err)
		}
		var answer wikiSessionNoteAnswer
		if err := json.Unmarshal(raw, &answer); err != nil {
			return wikiAnswer{}, fmt.Errorf("wiki_note: the server's answer is not the shape this build reads: %w", err)
		}
		return wikiAnswer{Text: describeWikiNote(answer), Data: answer}, nil

	case "wiki_draft":
		body, err := wikiDraftBody(args)
		if err != nil {
			return wikiAnswer{}, err
		}
		raw, err := t.draftWiki(caller.sessionID, body)
		if err != nil {
			return wikiAnswer{}, wikiDraftCallError(err)
		}
		var answer wikiDraftAnswer
		if err := json.Unmarshal(raw, &answer); err != nil {
			return wikiAnswer{}, fmt.Errorf("wiki_draft: the server's answer is not the shape this build reads: %w", err)
		}
		return wikiAnswer{Text: describeWikiDraft(answer), Data: answer}, nil
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
	// Unavailable is contract `searchUnavailable`: set only when the session has no wiki to search.
	Unavailable string `json:"unavailable,omitempty"`
}

// wikiSearchHit is one entry as the search ranked it, and no more than that: the legs that found it
// are the answer's own account of why it is here. Its fields are the contract's `hit`, in that order,
// and they are all that reaches the engine: the MCP door's structuredContent and `orbit wiki search
// --json` are this struct serialized, so a field the server sends and this does not name is dropped.
type wikiSearchHit struct {
	ID          string   `json:"id"`
	Kind        string   `json:"kind"`
	Title       string   `json:"title"`
	Summary     string   `json:"summary"`
	Trust       string   `json:"trust"`
	AnchorState string   `json:"anchorState"`
	Match       []string `json:"match"`
	Score       float64  `json:"score"`
	// How old the entry is (contract `age`), for the agent to judge for itself. A null from the server
	// (no check yet) and a field a server that predates them never sent are both left out, never "".
	RecordedAt       string `json:"recordedAt,omitempty"`
	ChangedAt        string `json:"changedAt,omitempty"`
	AnchorCheckedRef string `json:"anchorCheckedRef,omitempty"`
	AnchorCheckedAt  string `json:"anchorCheckedAt,omitempty"`
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
	// ServedBy is "server" where the deployment's own worker verifies the ops that wait for a verdict
	// (contract `reviewModes.verification.servedBy`, jobs.kindRuns.verify): the session runs nothing, and
	// nothing of it asks a model of this session's provider. Absent under the default runner mode, and the
	// wording this side answers with is unchanged wherever it is absent.
	ServedBy string `json:"servedBy"`
	// In a wiki chat (contract `agentSurface.chat.propose`): status draft, the card the ops that passed became, the
	// entries it resembles and the sections its press would rewrite. Nothing of the wiki was written.
	Status   string                   `json:"status,omitempty"`
	DraftID  string                   `json:"draftId,omitempty"`
	Similar  []map[string]interface{} `json:"similar,omitempty"`
	Rewrites []map[string]interface{} `json:"rewrites,omitempty"`
}

// wikiDraftAnswer is `POST /api/runner/wiki/drafts` (contract `agentSurface.chat.draft.returns`).
type wikiDraftAnswer struct {
	Status   string                   `json:"status"`
	DraftID  string                   `json:"draftId"`
	Kind     string                   `json:"kind"`
	Replayed bool                     `json:"replayed"`
	Rewrites []map[string]interface{} `json:"rewrites"`
}

// wikiSessionNoteAnswer is `POST /api/runner/wiki/notes` (contract `agentSurface.note.answer`). challenged is passed
// through whole: it is the server's own account of an op, in the wire shape wiki_propose's ops have.
type wikiSessionNoteAnswer struct {
	Noted      bool                   `json:"noted"`
	NoteID     string                 `json:"noteId"`
	Created    bool                   `json:"created"`
	ReadBy     string                 `json:"readBy"`
	Challenged map[string]interface{} `json:"challenged,omitempty"`
}

// wikiNoteBody reads a note's arguments into the door's body. What the limits say a request would be
// refused for is said here too, before it is sent; the server holds the rest, and names each field.
func wikiNoteBody(args map[string]interface{}) (map[string]interface{}, error) {
	text := strings.TrimSpace(getString(args, "text"))
	if text == "" {
		return nil, fmt.Errorf("text is required: one claim, in one or two sentences")
	}
	if count := utf8.RuneCountInString(text); count > wikiNoteTextMaxChars {
		return nil, fmt.Errorf("text is %d characters, and a note is at most %d: one claim, in one or two sentences", count, wikiNoteTextMaxChars)
	}
	paths := uniqueStrings(trimmed(getStringSlice(args, "paths")))
	if len(paths) > wikiNotePathsMax {
		return nil, fmt.Errorf("paths takes at most %d, got %d: name the ones the claim is about", wikiNotePathsMax, len(paths))
	}
	body := map[string]interface{}{"text": text}
	if len(paths) > 0 {
		body["paths"] = paths
	}
	if corrects := strings.TrimSpace(getString(args, "corrects")); corrects != "" {
		body["corrects"] = corrects
	}
	if replaces := strings.TrimSpace(getString(args, "replaces")); replaces != "" {
		body["replaces"] = replaces
	}
	return body, nil
}

// wikiDraftBody reads wiki_draft's arguments into the door's body. What the contract bounds is said here before it is
// sent — the kind, one to five sections each with its document and its key, a reason and a key; the server holds the
// rest (each section a written one of the confirmed plan, a plan change gated as a proposal is) and names each field
// it refuses.
func wikiDraftBody(args map[string]interface{}) (map[string]interface{}, error) {
	kind := strings.ToLower(strings.TrimSpace(getString(args, "kind")))
	if !contains(wikiDraftKinds, kind) {
		return nil, fmt.Errorf("kind is required: rewrite (sections that lag behind main, written again from it) or plan")
	}
	reason := strings.TrimSpace(getString(args, "reason"))
	if reason == "" {
		return nil, fmt.Errorf("reason is required: why, in a sentence or two; the card shows it")
	}
	key := strings.TrimSpace(getString(args, "idempotencyKey"))
	if key == "" {
		return nil, fmt.Errorf("idempotencyKey is required: the same key with the same request answers with the card it " +
			"made, so a retry after an answer you never saw drafts nothing twice")
	}
	body := map[string]interface{}{"kind": kind, "reason": reason, "idempotencyKey": key}
	if kind == "rewrite" {
		sections, err := wikiDraftSectionsArg(args["sections"])
		if err != nil {
			return nil, err
		}
		body["sections"] = sections
	}
	if change, ok := args["change"].(map[string]interface{}); ok {
		body["change"] = change
	}
	if replaces := strings.TrimSpace(getString(args, "replaces")); replaces != "" {
		body["replaces"] = replaces
	}
	return body, nil
}

// wikiDraftSectionsArg reads sections: an array of { doc, section }, or that array sent as a JSON string, which models do.
func wikiDraftSectionsArg(raw interface{}) ([]interface{}, error) {
	var sections []interface{}
	switch value := raw.(type) {
	case nil:
		return nil, fmt.Errorf("sections is required for a rewrite: 1 to %d of { doc, section }", wikiDraftSectionsMax)
	case []interface{}:
		sections = value
	case string:
		if err := json.Unmarshal([]byte(strings.TrimSpace(value)), &sections); err != nil {
			return nil, fmt.Errorf("sections must be a JSON array of { doc, section }: %v", err)
		}
	default:
		return nil, fmt.Errorf("sections must be an array of { doc, section }")
	}
	if len(sections) < 1 || len(sections) > wikiDraftSectionsMax {
		return nil, fmt.Errorf("sections takes 1 to %d sections, got %d: a card rewrites at most %d", wikiDraftSectionsMax, len(sections), wikiDraftSectionsMax)
	}
	out := make([]interface{}, 0, len(sections))
	for i, one := range sections {
		section, ok := one.(map[string]interface{})
		doc := strings.TrimSpace(getString(section, "doc"))
		key := strings.TrimSpace(getString(section, "section"))
		if !ok || doc == "" || key == "" {
			return nil, fmt.Errorf("sections[%d] must name the document's slug as doc and the section's key as section", i)
		}
		out = append(out, map[string]interface{}{"doc": doc, "section": key})
	}
	return out, nil
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
	// No wiki to search is not a search that found nothing (design §3.3): the agent carries on without it.
	switch answer.Unavailable {
	case "no_wiki":
		return "No wiki for this repository yet, so there is nothing to look up. Carry on without it."
	case "wiki_in_trash":
		return "The wiki for this repository is in Trash: the owner restores it from Trash."
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
		if age := describeWikiHitAge(hit); age != "" {
			fmt.Fprintf(&out, "    %s\n", age)
		}
	}
	out.WriteString("Read one in full with wiki_get, and refer to it in a reply as [title](orbit-wiki:<id>).")
	return out.String()
}

// describeWikiHitAge is the line under a hit that says how old it is (contract `age`): when the entry
// was recorded, when its current revision was written, and the commit its anchors were last checked
// at. Empty from a server that predates them; a check not made yet is the hit's own "anchor unchecked".
func describeWikiHitAge(hit wikiSearchHit) string {
	var parts []string
	if hit.RecordedAt != "" {
		parts = append(parts, "recorded "+wikiTimeOf(hit.RecordedAt))
	}
	if hit.ChangedAt != "" {
		parts = append(parts, "current revision "+wikiTimeOf(hit.ChangedAt))
	}
	if hit.AnchorCheckedRef != "" {
		check := "anchors last checked at " + wikiRefOf(hit.AnchorCheckedRef)
		if hit.AnchorCheckedAt != "" {
			check += " on " + wikiTimeOf(hit.AnchorCheckedAt)
		}
		parts = append(parts, check)
	}
	return strings.Join(parts, " · ")
}

// wikiTimeOf is a server time to the minute, in UTC (2026-10-03 11:39Z); one that does not parse is
// shown as it came.
func wikiTimeOf(value string) string {
	at, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return value
	}
	return at.UTC().Format("2006-01-02 15:04Z")
}

// wikiRefOf is a check's ref as it is typed: a commit by its first 12 characters, as the server's own
// challenge names the commit it checked at, and any other ref whole.
func wikiRefOf(ref string) string {
	if wikiCommitSha.MatchString(ref) {
		return ref[:12]
	}
	return ref
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
// allowed to say about it: what is pending is not knowledge, and what was applied is live.
func describeWikiPropose(answer wikiProposeAnswer, names []string, dryRun bool) string {
	if answer.Status == "draft" {
		return describeWikiChatPropose(answer, names, dryRun)
	}
	var out strings.Builder
	switch {
	case dryRun:
		out.WriteString("Dry run: every op was checked, and NOTHING was recorded — no other session, and no owner, has seen any of this.\n")
	case answer.Replayed:
		fmt.Fprintf(&out, "This request was already recorded under this idempotencyKey, and this is that answer; nothing was proposed twice. Changeset %s.\n", answer.ChangesetID)
	case answer.ChangesetID == "":
		out.WriteString("Nothing was recorded: every op was refused. The reasons below are the whole answer.\n")
	case answer.ServedBy == "server" && wikiOpsWaitForVerification(answer.Ops):
		// The server's own verification (contract `reviewModes.verification.servedBy`): the deployment's
		// worker runs the pipeline with the System model, so the verdict arrives by itself — there is no
		// command for this session to run, and no model of its provider is asked about any of this.
		fmt.Fprintf(&out, "Recorded: changeset %s. It is not saved yet: in this automatic space the deployment's "+
			"own worker verifies what waits for its verification, so the verdict arrives by itself — nothing for "+
			"this session to run, and no model of this session's is asked. Anything else pending waits for the "+
			"owner in Review; until then no other session reads it and it is not knowledge.\n", answer.ChangesetID)
	case wikiOpsWaitForVerification(answer.Ops):
		// An automatic space: what it took waits for a verdict, not for the owner (contract
		// `reviewModes.verification`), and the command that asks for one is this session's to run.
		fmt.Fprintf(&out, "Recorded: changeset %s. It is not saved: in this automatic space what waits for its "+
			"verification goes live only when `orbit wiki verify` reports a verdict for it, and anything else pending "+
			"waits for the owner in Review; until then no other session reads it and it is not knowledge.\n", answer.ChangesetID)
	case wikiOpsCount(answer.Ops, "pending") > 0:
		fmt.Fprintf(&out, "Recorded: changeset %s. What is pending is a proposal for the owner's review. It is not "+
			"saved: the owner decides in Review, and until they do, no other session reads it and it is not "+
			"knowledge.\n", answer.ChangesetID)
	default:
		fmt.Fprintf(&out, "Recorded: changeset %s.\n", answer.ChangesetID)
	}
	for _, op := range answer.Ops {
		out.WriteString("  " + describeWikiOp(op, names, answer.ServedBy == "server"))
		out.WriteString("\n")
	}
	// A dry run recorded nothing, whatever its ops answer as, so there is nothing of it to report.
	if dryRun {
		return out.String()
	}
	if wikiOpsCount(answer.Ops, "applied") > 0 {
		out.WriteString("What is applied is live now, and other sessions of this space can find it.\n")
	}
	if wikiOpsCount(answer.Ops, "pending") > 0 {
		out.WriteString("Report what is pending as a proposal, never as a saved entry.\n")
	}
	return out.String()
}

// describeWikiChatPropose is a wiki chat's answer (contract `agentSurface.chat.propose`): the ops that passed are one card
// the owner may press, and nothing of the wiki changed — which is the one thing the agent must not say otherwise.
func describeWikiChatPropose(answer wikiProposeAnswer, names []string, dryRun bool) string {
	var out strings.Builder
	switch {
	case dryRun:
		out.WriteString("Dry run in a wiki chat: every op was checked, and NO card was made — the owner sees nothing of this.\n")
	case answer.Replayed:
		fmt.Fprintf(&out, "This request already made card %s under this idempotencyKey, and this is that answer; nothing was drafted twice.\n", answer.DraftID)
	default:
		fmt.Fprintf(&out, "Drafted card %s for the owner of this wiki chat. Nothing in the wiki changed: the owner presses Apply, "+
			"Edit or Discard on the card, and until then no session reads any of it. Say what the card would change, and never "+
			"call it applied; pass replaces: %s when you revise it.\n", answer.DraftID, answer.DraftID)
	}
	for _, op := range answer.Ops {
		if status, _ := op["status"].(string); status == "draft" {
			line := "op " + strconv.Itoa(int(wikiFloat(op["seq"])))
			if seq := int(wikiFloat(op["seq"])); seq >= 0 && seq < len(names) && names[seq] != "" {
				line += " " + names[seq]
			}
			line += ": on the card"
			if similar := wikiMapSlice(op["similar"]); len(similar) > 0 {
				parts := make([]string, 0, len(similar))
				for _, neighbour := range similar {
					id, _ := neighbour["id"].(string)
					title, _ := neighbour["title"].(string)
					parts = append(parts, strings.TrimSpace(id+" "+title))
				}
				line += "; similar: " + strings.Join(parts, " | ")
			}
			out.WriteString("  " + line + "\n")
			continue
		}
		out.WriteString("  " + describeWikiOp(op, names, answer.ServedBy == "server") + "\n")
	}
	if len(answer.Rewrites) > 0 {
		wheres := make([]string, 0, len(answer.Rewrites))
		for _, section := range answer.Rewrites {
			where, _ := section["where"].(string)
			title, _ := section["title"].(string)
			wheres = append(wheres, strings.TrimSpace(where+" "+title))
		}
		out.WriteString("Once applied, the card's press rewrites: " + strings.Join(wheres, "; ") + ".\n")
	}
	return out.String()
}

// describeWikiDraft says what wiki_draft made: a card, and nothing written.
func describeWikiDraft(answer wikiDraftAnswer) string {
	var out strings.Builder
	if answer.Replayed {
		fmt.Fprintf(&out, "This request already made card %s under this idempotencyKey, and this is that answer; nothing was drafted twice.", answer.DraftID)
	} else if answer.Kind == "plan" {
		fmt.Fprintf(&out, "Drafted card %s (plan) for the owner of this wiki chat. Nothing was written: the owner presses the card, and "+
			"only then is the plan changed, confirmed and its documents rebuilt. Never call it applied; pass replaces: %s when you revise it.",
			answer.DraftID, answer.DraftID)
	} else {
		fmt.Fprintf(&out, "Drafted card %s (%s) for the owner of this wiki chat. Nothing was written: the owner presses the card, and "+
			"only then are the sections rewritten. Never call it applied; pass replaces: %s when you revise it.", answer.DraftID, answer.Kind, answer.DraftID)
	}
	if len(answer.Rewrites) > 0 {
		wheres := make([]string, 0, len(answer.Rewrites))
		for _, section := range answer.Rewrites {
			where, _ := section["where"].(string)
			title, _ := section["title"].(string)
			wheres = append(wheres, strings.TrimSpace(where+" "+title))
		}
		out.WriteString("\nIts press would rewrite: " + strings.Join(wheres, "; ") + ".")
	}
	return out.String()
}

// wikiFloat is a JSON number, or -1.
func wikiFloat(raw interface{}) float64 {
	if value, ok := raw.(float64); ok {
		return value
	}
	return -1
}

// describeWikiNote says what a note is in the terms that decide what the agent may say of it: it is kept, and it
// is not knowledge. What it corrects is told apart, since that takes effect now, or does not.
func describeWikiNote(answer wikiSessionNoteAnswer) string {
	var out strings.Builder
	if answer.Created {
		fmt.Fprintf(&out, "Noted as %s.", answer.NoteID)
	} else {
		fmt.Fprintf(&out, "The space already holds this text as note %s, so nothing new was written.", answer.NoteID)
	}
	fmt.Fprintf(&out, " It is not in the wiki yet and may never be: maintenance reads a note against the records of the "+
		"session that wrote it, and writes an entry only if they bear it out. Read by: %s.", answer.ReadBy)
	if answer.Challenged == nil {
		return out.String()
	}
	if status, _ := answer.Challenged["status"].(string); status == "draft" {
		draft, _ := answer.Challenged["draftId"].(string)
		fmt.Fprintf(&out, "\nIn this wiki chat the flag is card %s, for the owner to apply: the entry is NOT flagged until they do.", draft)
		return out.String()
	}
	if status, _ := answer.Challenged["status"].(string); status != "refused" {
		entry, _ := answer.Challenged["entryId"].(string)
		fmt.Fprintf(&out, "\nEntry %s is flagged now: it is challenged, and the owner answers that in Review.", entry)
		return out.String()
	}
	out.WriteString("\nThe entry it corrects was NOT flagged:")
	for _, reason := range wikiMapSlice(answer.Challenged["reasons"]) {
		code, _ := reason["code"].(string)
		message, _ := reason["message"].(string)
		out.WriteString(" " + strings.TrimSpace(code+" "+message))
	}
	out.WriteString(" Find its id with wiki_search; the same note sent again with the right id writes no second note.")
	return out.String()
}

// wikiOpsCount is how many ops of an answer have this status.
func wikiOpsCount(ops []map[string]interface{}, status string) int {
	count := 0
	for _, op := range ops {
		if got, _ := op["status"].(string); got == status {
			count++
		}
	}
	return count
}

// describeWikiOp is one op's line. server says the deployment's own worker verifies what waits
// (`reviewModes.verification.servedBy`), which is what a session waiting for a verdict is told: the
// verdict arrives by itself, nothing is asked of this session's provider.
func describeWikiOp(op map[string]interface{}, names []string, server bool) string {
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
		if waits, _ := op["waitsFor"].(string); waits == "verification" {
			if server {
				line += "pending — the deployment's own worker verifies it, not live yet"
			} else {
				line += "pending — waiting for its verification (orbit wiki verify), not live yet"
			}
		} else {
			line += "pending — waiting for the owner's review"
		}
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
			// And each field it names, by path: which op's which source a refusal is about is in
			// errors[], and a WIKI_SCHEMA's message alone does not say.
			for _, field := range wikiMapSlice(reason["errors"]) {
				path, _ := field["path"].(string)
				detail, _ := field["message"].(string)
				line += "; " + strings.TrimSpace(path+" "+detail)
			}
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

// wikiOpsWaitForVerification reports whether any op of an answer waits for its verification rather
// than for the owner: what an automatic space takes in (contract `reviewModes.verification.waits`).
func wikiOpsWaitForVerification(ops []map[string]interface{}) bool {
	for _, op := range ops {
		if waits, _ := op["waitsFor"].(string); waits == "verification" {
			return true
		}
	}
	return false
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

// wikiNoteCallError is wikiCallError for wiki_note, whose door is newer than the rest of the wiki's: a server that
// has the wiki and not this route answers a plain 404 too, and it is not true of it that nothing can be read or
// proposed there. So it is told apart: this binary is newer than its server, which is what the answer has to say.
func wikiNoteCallError(err error) error {
	if wikiDoorMissing(err) {
		return fmt.Errorf("wiki_note: this Orbit server is too old for wiki_note (it answered 404 for POST " +
			"/api/runner/wiki/notes), so the note was NOT recorded, and any entry it corrects was not flagged. " +
			"Upgrade the Orbit server; until then tell the user what you learned, or propose it with wiki_propose")
	}
	return wikiCallError("wiki_note", err)
}

// wikiDraftCallError is wikiCallError for wiki_draft, whose door is newer still: a server that has the wiki and not this
// route answers a plain 404, and what is true then is that this binary is newer than its server, so no card was made.
func wikiDraftCallError(err error) error {
	if wikiDoorMissing(err) {
		return fmt.Errorf("wiki_draft: this Orbit server is too old for wiki_draft (it answered 404 for POST " +
			"/api/runner/wiki/drafts), so no card was made. Tell the owner what should be rewritten, or draft an entry " +
			"with wiki_propose")
	}
	return wikiCallError("wiki_draft", err)
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

// searchWiki, getWikiEntry, proposeWikiChangeset, writeWikiNote and draftWiki live in transport.go with the other ops;
// the header these calls carry is the calling session's, which is what the door resolves the space from.
