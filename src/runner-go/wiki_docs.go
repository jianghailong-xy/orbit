package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"time"
)

// The documents (contracts/wiki.contract.json `docs`, migrations 0326 and 0337, criterion 9): what the
// runner sends when a Wiki maintenance run writes a document's sections from the confirmed plan, what the
// server answers when it refuses the write, and the two reads the writer needs besides. wiki_docs_test.go
// holds every name and number below to the contract; the writer (`orbit wiki docs build`,
// wiki_docs_build.go) builds on them.
//
// The server checks what it can: it reads a record a footnote names again, redacts it and looks for the
// quote itself. A design document, code or a contract exists only in a checkout, so the writer checks
// those quotes here, on the runner, at a sha, and says so (`verified`, with `sha` and `lines`); a
// repository footnote without a sha is refused. Every section is kept with the origin/main commit the
// run read the repository at (`repoSha`), which a later run compares with origin/main to know which
// sections cite something that has changed.

// The contract's closed sets (`docs.statuses`, `docs.sentenceStatuses`, `docs.repoKinds`,
// `docs.recordKinds`, `docs.verdicts`, `docs.checkers`, `docs.withdrawReasons`).
var (
	wikiDocStatuses         = []string{"ok", "needs_review"}
	wikiDocSentenceStatuses = []string{"sourced", "transition", "unsourced", "unverified", "withdrawn"}
	wikiDocRepoKinds        = []string{"design_doc", "code", "contract"}
	wikiDocRecordKinds      = []string{"turn", "event", "tool_call", "task", "task_comment", "approval", "owner_decision", "merge_receipt", "note"}
	wikiDocVerdicts         = []string{"verified", "not_found", "no_quote", "unresolved"}
	wikiDocCheckers         = []string{"server", "runner"}
	wikiDocWithdrawReasons  = []string{"rejected", "retired", "superseded", "anchor_changed", "anchor_missing"}
	// `docs.dispositionActions`: what became of one piece of a section's material.
	wikiDocDispositionActions = []string{"adopt", "merge", "drop", "over_cap", "filtered"}
	// `docs.material.weights`: the evidence weight the merge reads a record with, heaviest first.
	wikiDocMaterialWeights = []string{"decision", "merge", "output", "error", "other"}
)

// The numbers a write is held to (`docs.rules`).
const (
	// A document whose unsourced and unverified sentences are more than this share of all needs review.
	wikiDocNeedsReviewAbove = 0.05
	// A quote shorter than this, once folded, is found nowhere.
	wikiDocQuoteMinChars = 4
	// One write carries at most this many sections: a whole plan document.
	wikiDocSectionsPerWrite = 20
	wikiDocFootnotesMax     = 200
	// A section's material ledger lists at most this many pieces, each reason at most this long.
	wikiDocDispositionsMax  = 200
	wikiDocReasonMaxChars   = 500
	wikiDocQuoteMaxChars    = 1000
	wikiDocExcerptMaxChars  = 4000
	wikiDocMarkdownMaxChars = 20000
)

// The code the write's shape is refused with (contract `refusals`).
const wikiDocInvalidCode = "WIKI_DOC_INVALID"

// A document write re-reads every record its footnotes name: a large section's worth of lookups.
const wikiDocTimeout = 2 * time.Minute

// ── What a write is (`docs.schema`) ─────────────────────────────────────────────────────────────

// wikiDocRange is a repository footnote's lines (1-based, inclusive) or a record footnote's characters
// (code points of the redacted record, end exclusive).
type wikiDocRange struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

// wikiDocFootnote is one footnote of a section: `[n]` in the section's markdown names footnotes[n-1].
// A repository original (design_doc, code, contract) carries path, sha, lines and the runner's own check;
// a record (turn, event, tool_call, …) its id, and the server checks it. Quote is nil when none was given.
type wikiDocFootnote struct {
	Kind string `json:"kind"`
	// A repository original: path@sha#Lstart-end, a design document's section or a code symbol, the
	// quoted lines as read, and whether the quote was found in them at that sha.
	Path     string        `json:"path,omitempty"`
	Sha      string        `json:"sha,omitempty"`
	Lines    *wikiDocRange `json:"lines,omitempty"`
	Section  string        `json:"section,omitempty"`
	Symbol   string        `json:"symbol,omitempty"`
	Excerpt  string        `json:"excerpt,omitempty"`
	Verified *bool         `json:"verified,omitempty"`
	// A record: its id, and where in it to look.
	Ref   string        `json:"ref,omitempty"`
	Chars *wikiDocRange `json:"chars,omitempty"`
	Quote *string       `json:"quote"`
	// The entry of the space the original was found through, when it was.
	ViaEntryID string `json:"viaEntryId,omitempty"`
	// found is the writer's own finding of a record's quote in the text the server handed out: never sent,
	// since the server checks a record's quote itself.
	found bool
}

// wikiDocDisposition is what became of one piece of a section's material (contract `docs.dispositions`):
// the model's merge adopted it, folded it into another, or dropped it; or the runner never handed it
// over (over_cap, filtered). Into names the piece it was merged into, and is null for anything else.
type wikiDocDisposition struct {
	Material string  `json:"material"`
	Kind     string  `json:"kind"`
	Ref      string  `json:"ref"`
	Action   string  `json:"action"`
	Into     *string `json:"into"`
	Reason   string  `json:"reason"`
}

// wikiDocSection is one section written: the plan section's key, the fingerprint of its material, its
// body, and what became of each piece of its material.
type wikiDocSection struct {
	Key            string               `json:"key"`
	MaterialSha256 string               `json:"materialSha256"`
	Markdown       string               `json:"markdown"`
	Footnotes      []wikiDocFootnote    `json:"footnotes"`
	Dispositions   []wikiDocDisposition `json:"dispositions"`
}

// wikiDocWriteRequest is `POST /api/runner/wiki/spaces/:id/docs/:slug`.
type wikiDocWriteRequest struct {
	// The confirmed plan version the document was written from.
	PlanVersion int `json:"planVersion"`
	// The origin/main commit (40 lowercase hex) the run read the repository at.
	RepoSha  string           `json:"repoSha"`
	Model    string           `json:"model,omitempty"`
	Sections []wikiDocSection `json:"sections"`
}

// ── What the server answers ─────────────────────────────────────────────────────────────────────

// wikiDocFieldError is one thing wrong with a write: where in the request, and why.
type wikiDocFieldError struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

// wikiDocRefusal is a 422 WIKI_DOC_INVALID: everything wrong with the write. Nothing was written.
type wikiDocRefusal struct {
	Code    string              `json:"code"`
	Message string              `json:"message"`
	Errors  []wikiDocFieldError `json:"errors"`
}

// wikiDocRefused reads a refusal of the write's shape out of a call's error; ok is false for any other.
func wikiDocRefused(err error) (wikiDocRefusal, bool) {
	var httpErr *transportHTTPError
	if !errors.As(err, &httpErr) || httpErr.statusCode != http.StatusUnprocessableEntity {
		return wikiDocRefusal{}, false
	}
	var refusal wikiDocRefusal
	if json.Unmarshal([]byte(httpErr.body), &refusal) != nil || refusal.Code != wikiDocInvalidCode {
		return wikiDocRefusal{}, false
	}
	return refusal, true
}

// ── The runner door's two routes (`docs.routes`), each a maintenance route ──────────────────────

func wikiDocsPath(spaceID string) string {
	return "/runner/wiki/spaces/" + url.PathEscape(spaceID) + "/docs"
}

// wikiDocMaterialOf is `GET …/docs/:slug/material?section=<key>`: the server's half of one section's
// material — the entries its session condition picks and the records found through them or by its
// projects, window and keywords, each redacted and placed (contract `docs.reads.material`).
func (t *Transport) wikiDocMaterialOf(sessionID, spaceID, slug, key string) (json.RawMessage, error) {
	if err := validatePathSegmentID(spaceID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	path := wikiDocsPath(spaceID) + "/" + url.PathEscape(slug) + "/material?section=" + url.QueryEscape(key)
	_, err := t.doWiki(http.MethodGet, path, nil, &out, wikiDocTimeout, sessionHeader(sessionID), true)
	return out, err
}

// wikiDocWritten is `GET …/docs/:slug`: one document as it is written, the owner's read on the runner
// door (contract `docs.reads.writerDoc`).
func (t *Transport) wikiDocWritten(sessionID, spaceID, slug string) (json.RawMessage, error) {
	if err := validatePathSegmentID(spaceID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	_, err := t.doWiki(http.MethodGet, wikiDocsPath(spaceID)+"/"+url.PathEscape(slug), nil, &out, wikiDocTimeout, sessionHeader(sessionID), true)
	return out, err
}

// wikiDocsState is `GET …/docs`: every written document with its sections' fingerprints, the commit each
// was generated at and whether it is stale, and the confirmed plan's version — the server's own wire shape.
func (t *Transport) wikiDocsState(sessionID, spaceID string) (json.RawMessage, error) {
	if err := validatePathSegmentID(spaceID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	_, err := t.doWiki(http.MethodGet, wikiDocsPath(spaceID), nil, &out, wikiDocTimeout, sessionHeader(sessionID), true)
	return out, err
}

// writeWikiDoc writes sections of one document, or answers the refusal of its shape (wikiDocRefused). It
// may land twice (wiki_retry.go): a section whose stored fingerprint is the one the write names, and from
// which nothing was withdrawn since, is left as it is (contract `docs.regeneration`), so a second landing of
// the same write records nothing more.
func (t *Transport) writeWikiDoc(sessionID, spaceID, slug string, write wikiDocWriteRequest) (json.RawMessage, error) {
	if err := validatePathSegmentID(spaceID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	_, err := t.doWiki(http.MethodPost, wikiDocsPath(spaceID)+"/"+url.PathEscape(slug), write, &out, wikiDocTimeout, sessionHeader(sessionID), true)
	return out, err
}
