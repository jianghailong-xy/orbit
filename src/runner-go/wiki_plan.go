package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"time"
)

// The plan (contracts/wiki.contract.json `plan`, migration 0325, criterion 11): what the runner sends
// when a Wiki maintenance run drafts a space's plan or proposes a change to it, and what the server's
// gate answers when it refuses one. wiki_plan_test.go holds every name and number below to the
// contract; the drafting job (`orbit wiki plan draft`) builds on them.
//
// The server checks what it can — the schema, the document count, protected documents, and every
// project, topic and entry kind a section names. Files, docs sections and symbols exist only in a
// checkout, so the drafting job checks those here, on the runner, and reports what it found with the
// sha it checked at (wikiPlanRepoCheck); the server keeps the report and does not judge it.

// The contract's closed sets (`plan.statuses`, `plan.sectionKinds`, `plan.proposals`, `plan.gate`,
// `plan.newFields`).
var (
	wikiPlanStatuses         = []string{"draft", "confirmed", "superseded"}
	wikiPlanSectionKinds     = []string{"overview", "concepts", "flow", "interface", "data", "ops", "pitfalls", "decisions", "conventions", "other"}
	wikiPlanProposalStatuses = []string{"pending", "accepted", "rejected"}
	wikiPlanFactKinds        = []string{"entry", "session", "commit"}
	wikiPlanGateChecks       = []string{"schema", "docCount", "protected", "references"}
	wikiPlanNewFieldLevels   = []string{"category", "doc", "section"}
	wikiPlanRepoRefKinds     = []string{"file", "docSection", "symbol", "contract"}
)

// The document count a draft is held to when it names no target (`plan.rules`).
const (
	wikiPlanDocsMin = 20
	wikiPlanDocsMax = 35
)

// The codes the plan's routes refuse with (contract `refusals`).
const (
	wikiPlanGateCode        = "WIKI_PLAN_GATE"
	wikiPlanStaleCode       = "WIKI_PLAN_STALE"
	wikiPlanUnconfirmedCode = "WIKI_PLAN_UNCONFIRMED"
)

// A plan is the biggest thing a maintenance run sends: forty documents with their outlines.
const wikiPlanTimeout = 2 * time.Minute

// ── What a draft is written as (`plan.schema`) ──────────────────────────────────────────────────

type wikiPlanCategory struct {
	Key       string                 `json:"key"`
	Title     string                 `json:"title"`
	Question  string                 `json:"question,omitempty"`
	ForAgents bool                   `json:"forAgents,omitempty"`
	Extra     map[string]interface{} `json:"extra,omitempty"`
}

type wikiPlanScopeOut struct {
	Text string   `json:"text"`
	Docs []string `json:"docs"`
}

type wikiPlanLength struct {
	Min int `json:"min"`
	Max int `json:"max"`
}

type wikiPlanDocSource struct {
	Path    string  `json:"path"`
	Section *string `json:"section"`
}

type wikiPlanCodeSource struct {
	Path    string   `json:"path"`
	Symbols []string `json:"symbols"`
}

type wikiPlanContractSource struct {
	Path string `json:"path"`
}

// wikiPlanSessions is a section's session condition: where its original words are looked for.
type wikiPlanSessions struct {
	// Projects of the owner, each by id or exact title.
	Projects    []string `json:"projects"`
	Since       *string  `json:"since"`
	Until       *string  `json:"until"`
	Keywords    []string `json:"keywords"`
	AnchorPaths []string `json:"anchorPaths"`
	EntryKinds  []string `json:"entryKinds"`
	Topics      []string `json:"topics"`
	Evidence    string   `json:"evidence"`
}

type wikiPlanSources struct {
	Docs      []wikiPlanDocSource      `json:"docs"`
	Code      []wikiPlanCodeSource     `json:"code"`
	Contracts []wikiPlanContractSource `json:"contracts"`
	Sessions  *wikiPlanSessions        `json:"sessions"`
}

type wikiPlanSection struct {
	// Stable within its document; the server gives one to a section that has none.
	Key     string                 `json:"key,omitempty"`
	Title   string                 `json:"title"`
	Kind    string                 `json:"kind"`
	Covers  string                 `json:"covers"`
	Length  int                    `json:"length"`
	Sources wikiPlanSources        `json:"sources"`
	Extra   map[string]interface{} `json:"extra,omitempty"`
}

type wikiPlanDoc struct {
	Category string             `json:"category"`
	Slug     string             `json:"slug"`
	Title    string             `json:"title"`
	Question string             `json:"question"`
	Audience []string           `json:"audience"`
	ScopeIn  []string           `json:"scopeIn"`
	ScopeOut []wikiPlanScopeOut `json:"scopeOut"`
	Length   wikiPlanLength     `json:"length"`
	// Only the owner protects a document; a draft carries a protected one exactly as it was.
	Protected bool                   `json:"protected,omitempty"`
	Sections  []wikiPlanSection      `json:"sections"`
	Extra     map[string]interface{} `json:"extra,omitempty"`
}

// wikiPlanNewField declares a field the schema does not have, whose values go in `extra` at its level.
type wikiPlanNewField struct {
	At   string `json:"at"`
	Name string `json:"name"`
	Why  string `json:"why"`
}

type wikiPlanDraft struct {
	Categories []wikiPlanCategory `json:"categories"`
	Docs       []wikiPlanDoc      `json:"docs"`
	NewFields  []wikiPlanNewField `json:"newFields,omitempty"`
}

// wikiPlanRepoMiss is one repository reference the drafting job could not find at the sha it checked.
type wikiPlanRepoMiss struct {
	Kind string  `json:"kind"`
	Ref  string  `json:"ref"`
	At   *string `json:"at"`
}

type wikiPlanRepoCheck struct {
	Sha     string             `json:"sha"`
	Checked int                `json:"checked"`
	Missing []wikiPlanRepoMiss `json:"missing"`
}

// wikiPlanDraftRequest is `POST /api/runner/wiki/spaces/:id/plan/drafts`.
type wikiPlanDraftRequest struct {
	// The version this draft revises (the space's newest), or nil for its first.
	BaseVersion *int              `json:"baseVersion"`
	Target      *wikiPlanLength   `json:"target,omitempty"`
	Plan        wikiPlanDraft     `json:"plan"`
	RepoCheck   wikiPlanRepoCheck `json:"repoCheck"`
	Model       string            `json:"model,omitempty"`
}

type wikiPlanFact struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

type wikiPlanChange struct {
	Doc      wikiPlanDoc       `json:"doc"`
	Category *wikiPlanCategory `json:"category,omitempty"`
}

// wikiPlanProposalRequest is `POST /api/runner/wiki/spaces/:id/plan/proposals`.
type wikiPlanProposalRequest struct {
	Reason string         `json:"reason"`
	Change wikiPlanChange `json:"change"`
	Facts  []wikiPlanFact `json:"facts"`
}

// ── What the gate answers ───────────────────────────────────────────────────────────────────────

// wikiPlanGateError is one thing the gate found: which check, where in the request, and why.
type wikiPlanGateError struct {
	Check   string `json:"check"`
	Path    string `json:"path"`
	Message string `json:"message"`
}

// wikiPlanGateRefusal is a 422 WIKI_PLAN_GATE: everything the gate found, which the drafting job hands
// back to the model to draft again. Nothing was stored.
type wikiPlanGateRefusal struct {
	Code    string              `json:"code"`
	Message string              `json:"message"`
	Errors  []wikiPlanGateError `json:"errors"`
}

// wikiPlanGateRefused reads a refusal of the gate out of a call's error; ok is false for any other.
func wikiPlanGateRefused(err error) (wikiPlanGateRefusal, bool) {
	var httpErr *transportHTTPError
	if !errors.As(err, &httpErr) || httpErr.statusCode != http.StatusUnprocessableEntity {
		return wikiPlanGateRefusal{}, false
	}
	var refusal wikiPlanGateRefusal
	if json.Unmarshal([]byte(httpErr.body), &refusal) != nil || refusal.Code != wikiPlanGateCode {
		return wikiPlanGateRefusal{}, false
	}
	return refusal, true
}

// ── The runner door's three routes (`plan.routes`), each a maintenance route ────────────────────

func wikiPlanPath(spaceID string) string {
	return "/runner/wiki/spaces/" + url.PathEscape(spaceID) + "/plan"
}

// wikiPlanState is `GET …/plan`: the confirmed version, the draft and the pending proposals, as the
// server's own wire shape.
func (t *Transport) wikiPlanState(sessionID, spaceID string) (json.RawMessage, error) {
	if err := validatePathSegmentID(spaceID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	_, err := t.doWiki(http.MethodGet, wikiPlanPath(spaceID), nil, &out, wikiPlanTimeout, sessionHeader(sessionID), true)
	return out, err
}

// submitWikiPlanDraft stores a draft, or answers the gate's refusal (wikiPlanGateRefused).
func (t *Transport) submitWikiPlanDraft(sessionID, spaceID string, draft wikiPlanDraftRequest) (json.RawMessage, error) {
	if err := validatePathSegmentID(spaceID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	// Sent once: a draft that landed twice would be refused WIKI_PLAN_STALE the second time, its base no longer the newest.
	_, err := t.doWiki(http.MethodPost, wikiPlanPath(spaceID)+"/drafts", draft, &out, wikiPlanTimeout, sessionHeader(sessionID), false)
	return out, err
}

// proposeWikiPlanChange files a change to the confirmed plan for the owner to answer.
func (t *Transport) proposeWikiPlanChange(sessionID, spaceID string, proposal wikiPlanProposalRequest) (json.RawMessage, error) {
	if err := validatePathSegmentID(spaceID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	// Sent once: a proposal that landed twice would be two proposals.
	_, err := t.doWiki(http.MethodPost, wikiPlanPath(spaceID)+"/proposals", proposal, &out, wikiPlanTimeout, sessionHeader(sessionID), false)
	return out, err
}
