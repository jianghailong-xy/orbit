package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// A maintenance run's documents (criterion 3, revision 3; contracts/wiki.contract.json `maintenance.job.docs`).
//
// ONLY WHAT THE RUN'S FACTS TOUCHED IS WRITTEN AGAIN. After the entries are written and the anchors
// checked, the run asks the server which written sections of the confirmed plan an entry that changed
// since fits, and which a withdrawn sentence left stale (GET …/maintenance/docs); and it compares, in its
// own checkout, what each written section cites of the repository — its design documents' sections, its
// code's symbols, its contracts — at the commit the section was generated at and at origin/main now. Only
// the files those sections name are read, and a file git says did not change is not read at all. A cited
// file that is gone — deleted, or renamed away — withdraws the sentences citing it on the server
// (POST …/maintenance/docs/withdrawals). The sections so found, and — with no build of the space waiting
// to write them — the ones never written, go to `orbit wiki docs build`'s writer at that one commit; a
// section whose material's fingerprint is the stored one is left as it is, and asks no model.
//
// WHAT HAS NO PLACE IS PROPOSED, NOT WRITTEN. An entry that fits no section, and a design document new on
// origin/main that no section cites, are knowledge the plan has no place for. The run makes one proposal
// of them at most (POST …/plan/proposals): the local model says which document of the plan they belong in
// — rewritten with new sections — or which new document, in the plan's own line format; the run checks the
// sources it names on origin/main, the server gates the rest, and whatever either finds goes back to the
// model, three rounds at most. The plan changes only when the owner accepts it and confirms.
//
// NONE OF IT MOVES THE CURSOR. What a run wrote of the documents is recomputed from state by the next one —
// the entries changed since a section was written, the commits since its repoSha, the stale flags — so a
// section left unwritten, or a proposal that did not pass, is taken up again; the run reports it and still
// succeeds. A space with no confirmed plan writes no document at all, and the report says so.
//
// A SPACE THAT IS BEHIND WAITS (criterion 3, revision 4; contract `maintenance.job.catchUp.docs`). A run made
// while the space was behind — catching up, or its catch-up paused — skips the step whole: no section is written
// and no change to the plan proposed. Since what is written again is recomputed from state, the first run after
// the space has caught up takes up every section the entries and origin/main changed meanwhile, once, and leaves
// a section whose material did not change as it is: on 2026-10-01 the documents took 54 of a run's 93 minutes.

// The contract's numbers (`maintenance.job.docs.rules`), which wiki_maintain_docs_test.go holds to the JSON.
const (
	wikiMaintainProposalRoundsMax = 3
	wikiMaintainProposalItemsMax  = 12
)

// wikiMaintainDocsExcluded are the directories under docs/ that hold no design document.
var wikiMaintainDocsExcluded = []string{"docs/mocks/", "docs/evidence/"}

// ── The server's routes ─────────────────────────────────────────────────────────────────────────

// wikiMaintenanceDocsRead is `GET …/maintenance/docs` (contract `docs.reads.affected`).
type wikiMaintenanceDocsRead struct {
	SpaceID string `json:"spaceId"`
	Plan    *struct {
		Version     int     `json:"version"`
		ConfirmedAt string  `json:"confirmedAt"`
		RepoSha     *string `json:"repoSha"`
		DraftedAt   string  `json:"draftedAt"`
	} `json:"plan"`
	Build *struct {
		JobID   string `json:"jobId"`
		State   string `json:"state"`
		Version int    `json:"version"`
	} `json:"build"`
	Sections []struct {
		Doc         string   `json:"doc"`
		Key         string   `json:"key"`
		RepoSha     string   `json:"repoSha"`
		GeneratedAt string   `json:"generatedAt"`
		Stale       bool     `json:"stale"`
		EntryIDs    []string `json:"entryIds"`
	} `json:"sections"`
	Unplaced     []wikiUnplacedEntry `json:"unplaced"`
	UnplacedMore int                 `json:"unplacedMore"`
	Proposed     struct {
		EntryIDs []string `json:"entryIds"`
		Commits  []string `json:"commits"`
		Paths    []string `json:"paths"`
	} `json:"proposed"`
	// Topics are the space's, the ones the plan's gate takes in a session condition: nil from a server that predates
	// them, whose gate is then the only check of a proposal's topics.
	Topics []wikiPlanTopic `json:"topics"`
}

// wikiUnplacedEntry is an entry that fits no section of the confirmed plan.
type wikiUnplacedEntry struct {
	ID          string   `json:"id"`
	Kind        string   `json:"kind"`
	Title       string   `json:"title"`
	Summary     string   `json:"summary"`
	Topics      []string `json:"topics"`
	AnchorPaths []string `json:"anchorPaths"`
	ChangedAt   string   `json:"changedAt"`
}

func (t *Transport) wikiMaintenanceDocs(sessionID, spaceID string) (json.RawMessage, error) {
	if err := validatePathSegmentID(spaceID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	path := "/runner/wiki/spaces/" + url.PathEscape(spaceID) + "/maintenance/docs"
	_, err := t.doWiki(http.MethodGet, path, nil, &out, wikiPlanTimeout, sessionHeader(sessionID), true)
	return out, err
}

// withdrawWikiDocPaths names the repository files gone from origin/main. It may land twice: a sentence
// withdrawn already is not withdrawn again.
func (t *Transport) withdrawWikiDocPaths(sessionID, spaceID string, body interface{}) (json.RawMessage, error) {
	if err := validatePathSegmentID(spaceID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	path := "/runner/wiki/spaces/" + url.PathEscape(spaceID) + "/maintenance/docs/withdrawals"
	_, err := t.doWiki(http.MethodPost, path, body, &out, wikiPlanTimeout, sessionHeader(sessionID), true)
	return out, err
}

// ── What the step reports ───────────────────────────────────────────────────────────────────────

// wikiMaintainDocsReport is contracts/wiki.contract.json `maintenance.job.docs.report` (WikiMaintenanceDocsReport).
type wikiMaintainDocsReport struct {
	PlanVersion *int   `json:"planVersion"`
	Skipped     string `json:"skipped,omitempty"`
	RepoSha     string `json:"repoSha,omitempty"`
	Affected    struct {
		ByEntries int `json:"byEntries"`
		ByRepo    int `json:"byRepo"`
		Stale     int `json:"stale"`
		Unwritten int `json:"unwritten"`
		Total     int `json:"total"`
	} `json:"affected"`
	Withdrawn struct {
		Paths     int `json:"paths"`
		Sentences int `json:"sentences"`
	} `json:"withdrawn"`
	Sections struct {
		Written   int `json:"written"`
		Unchanged int `json:"unchanged"`
		Failed    int `json:"failed"`
	} `json:"sections"`
	Unplaced struct {
		DesignDocs int `json:"designDocs"`
		Entries    int `json:"entries"`
	} `json:"unplaced"`
	Proposal *wikiMaintainProposalReport `json:"proposal"`
	// What the step spent: its model calls (the sections' and the proposal's), and its time.
	Tokens struct {
		Input  int `json:"input"`
		Output int `json:"output"`
		Calls  int `json:"calls"`
	} `json:"tokens"`
	Seconds int `json:"seconds"`
	// Error is what stopped the step, when something did: the run still succeeds, and the next run takes it up.
	Error string `json:"error,omitempty"`
}

type wikiMaintainProposalReport struct {
	Outcome string `json:"outcome"` // proposed | failed
	ID      string `json:"id,omitempty"`
	Doc     string `json:"doc,omitempty"`
	NewDoc  bool   `json:"newDoc,omitempty"`
	Facts   int    `json:"facts,omitempty"`
	Rounds  int    `json:"rounds,omitempty"`
	Error   string `json:"error,omitempty"`
	// Reason is the proposal's why, as the owner reads it; kept in the summary, cut in the report.
	Reason string `json:"reason,omitempty"`
}

// ── The step ────────────────────────────────────────────────────────────────────────────────────

// docs is the run's documents step. It never fails the run: what it could not do it reports, and the next
// run, which recomputes what to write from the state it leaves, takes up again.
func (r *wikiMaintainRun) docs() error {
	report := &wikiMaintainDocsReport{}
	r.report.Docs = report
	if r.context.CatchUp != "" {
		report.Skipped = "catching_up"
		r.say("The space is catching up: its oldest fact not taken in is more than a day old, so no document was written and " +
			"no change to the plan proposed — the first run after it has caught up writes what changed meanwhile.")
		return nil
	}
	started := time.Now()
	r.mu.Lock()
	before := r.report.Tokens
	r.mu.Unlock()
	if err := r.writeDocs(report); err != nil {
		report.Error = cutRunes(err.Error(), 600)
		r.say("Documents: %v — the run goes on; the next run takes them up again.", err)
	}
	r.mu.Lock()
	report.Tokens.Input = r.report.Tokens.Input - before.Input
	report.Tokens.Output = r.report.Tokens.Output - before.Output
	report.Tokens.Calls = r.report.Tokens.Calls - before.Calls
	r.mu.Unlock()
	report.Seconds = int(time.Since(started).Seconds())
	return nil
}

// wikiMaintainSectionRef names one section of the confirmed plan.
type wikiMaintainSectionRef struct{ doc, key string }

func (r *wikiMaintainRun) writeDocs(report *wikiMaintainDocsReport) error {
	raw, err := r.t.wikiMaintenanceDocs(r.sessionID, r.spaceID)
	if err != nil {
		if wikiMaintenanceDoorMissing(err) {
			report.Skipped = "no_server_support"
			r.say("This Orbit server predates the documents' maintenance: no document was written.")
			return nil
		}
		return wikiMaintenanceCallError("orbit wiki maintain", r.spaceID, "--space", err)
	}
	var affected wikiMaintenanceDocsRead
	if err := json.Unmarshal(raw, &affected); err != nil {
		return fmt.Errorf("the server's sections to write are not the shape this build reads: %w", err)
	}
	if affected.Plan == nil {
		report.Skipped = "no_confirmed_plan"
		r.say("No confirmed plan: the space's owner has not confirmed a plan, so no document was written — the entries were.")
		return nil
	}
	version := affected.Plan.Version
	report.PlanVersion = &version

	// The confirmed plan, and what is written of it.
	planRaw, err := r.t.wikiPlanState(r.sessionID, r.spaceID)
	if err != nil {
		return wikiMaintenanceCallError("orbit wiki maintain", r.spaceID, "--space", err)
	}
	var plan wikiDocsPlanAnswer
	var full wikiPlanStateRead
	if json.Unmarshal(planRaw, &plan) != nil || json.Unmarshal(planRaw, &full) != nil || plan.Confirmed == nil || full.Confirmed == nil {
		return errors.New("the server's plan is not the shape this build reads, or has no confirmed version")
	}
	stateRaw, err := r.t.wikiDocsState(r.sessionID, r.spaceID)
	if err != nil {
		return wikiMaintenanceCallError("orbit wiki maintain", r.spaceID, "--space", err)
	}
	var state wikiDocsStateAnswer
	if err := json.Unmarshal(stateRaw, &state); err != nil {
		return fmt.Errorf("the server's record of what is written is not the shape this build reads: %w", err)
	}
	head, err := fetchWikiDocsRef(r.repo.root)
	if err != nil {
		return err
	}
	report.RepoSha = head

	take := map[string]map[string]bool{}
	add := func(ref wikiMaintainSectionRef) bool {
		if take[ref.doc] == nil {
			take[ref.doc] = map[string]bool{}
		}
		if take[ref.doc][ref.key] {
			return false
		}
		take[ref.doc][ref.key] = true
		return true
	}
	// The server's half: the entries, and what a withdrawn sentence left stale.
	for _, section := range affected.Sections {
		add(wikiMaintainSectionRef{section.Doc, section.Key})
		if section.Stale {
			report.Affected.Stale++
		} else {
			report.Affected.ByEntries++
		}
	}
	// The repository's half, here.
	changed, gone, err := r.repoAffected(plan.Confirmed.Docs, state, head)
	if err != nil {
		return err
	}
	for _, ref := range changed {
		add(ref)
	}
	report.Affected.ByRepo = len(changed)
	if len(gone) > 0 {
		answerRaw, err := r.t.withdrawWikiDocPaths(r.sessionID, r.spaceID, map[string]interface{}{"repoSha": head, "paths": gone})
		if err != nil {
			return wikiMaintenanceCallError("orbit wiki maintain", r.spaceID, "--space", err)
		}
		var answer struct {
			Withdrawn int `json:"withdrawn"`
			Sections  []struct {
				Doc string `json:"doc"`
				Key string `json:"key"`
			} `json:"sections"`
		}
		_ = json.Unmarshal(answerRaw, &answer)
		report.Withdrawn.Paths, report.Withdrawn.Sentences = len(gone), answer.Withdrawn
		for _, section := range answer.Sections {
			if add(wikiMaintainSectionRef{section.Doc, section.Key}) {
				report.Affected.Stale++
			}
		}
		r.say("Withdrew %s citing %s gone from origin/main.", wikiCount(answer.Withdrawn, "sentence", "sentences"), wikiCount(len(gone), "file", "files"))
	}
	// A build waiting or running writes what was never written; with none, the run does.
	if affected.Build == nil {
		written := map[string]map[string]bool{}
		for _, doc := range state.Docs {
			written[doc.Slug] = map[string]bool{}
			for _, section := range doc.Sections {
				written[doc.Slug][section.Key] = true
			}
		}
		for _, doc := range plan.Confirmed.Docs {
			for _, section := range doc.Sections {
				if !written[doc.Slug][section.Key] && add(wikiMaintainSectionRef{doc.Slug, section.Key}) {
					report.Affected.Unwritten++
				}
			}
		}
	}
	for _, keys := range take {
		report.Affected.Total += len(keys)
	}
	r.say("Documents of plan version %d at origin/main %s: %s to write again — %d by the entries, %d by the repository, %d stale, %d never written.",
		version, shortWikiHash(head), wikiCount(report.Affected.Total, "section", "sections"), report.Affected.ByEntries, report.Affected.ByRepo,
		report.Affected.Stale, report.Affected.Unwritten)

	var writeErr error
	if report.Affected.Total > 0 {
		summary, err := runWikiDocsBuild(r.t, r.sessionID, wikiDocsBuildOptions{
			spaceID: r.spaceID, repo: r.repo.root, sha: head, only: take, model: r.opts.model,
		}, r.progress)
		r.mu.Lock()
		r.report.Tokens.Calls += summary.Calls
		r.report.Tokens.Input += summary.Usage.InputTokens
		r.report.Tokens.Output += summary.Usage.OutputTokens
		r.mu.Unlock()
		report.Sections.Written, report.Sections.Unchanged, report.Sections.Failed = summary.Written, summary.Unchanged, summary.Failed
		writeErr = err
		if err == nil && summary.Failed > 0 {
			writeErr = fmt.Errorf("%s left unwritten", wikiCount(summary.Failed, "section was", "sections were"))
		}
	}

	// What has no place: one proposal at most.
	cited := map[string]bool{}
	for _, doc := range plan.Confirmed.Docs {
		for _, section := range doc.Sections {
			for _, source := range section.Sources.Docs {
				cited[wikiMaintainCleanPath(source.Path)] = true
			}
		}
	}
	for _, path := range affected.Proposed.Paths {
		cited[wikiMaintainCleanPath(path)] = true
	}
	base := ""
	if affected.Plan.RepoSha != nil {
		base = *affected.Plan.RepoSha
	}
	designs := r.newDesignDocs(base, head, cited)
	report.Unplaced.DesignDocs, report.Unplaced.Entries = len(designs), len(affected.Unplaced)+affected.UnplacedMore
	if len(designs) > 0 || len(affected.Unplaced) > 0 {
		report.Proposal = r.proposePlanChange(*full.Confirmed, designs, affected.Unplaced, head, affected.Topics)
	}
	return writeErr
}

// wikiMaintainCleanPath is a repository path as the plan and git both write it.
func wikiMaintainCleanPath(path string) string {
	return strings.TrimPrefix(strings.Trim(strings.TrimSpace(path), "`"), "./")
}

// ── The repository's half ───────────────────────────────────────────────────────────────────────

// wikiGonePath is a cited file origin/main no longer has, as the withdrawal names it.
type wikiGonePath struct {
	Path   string  `json:"path"`
	Change string  `json:"change"` // deleted | renamed
	To     *string `json:"to,omitempty"`
}

// wikiGitChange is one path git says changed between two commits.
type wikiGitChange struct {
	status string // A, M, D, R (the old path of a rename), T
	to     string // a rename's new path
}

// wikiGitChanges is `git diff --name-status -M from to`, keyed by the path at `from` (a rename's old one):
// the names of what changed, never the contents.
func wikiGitChanges(root, from, to string) (map[string]wikiGitChange, error) {
	out, code, stderr, err := wikiAnchorGit(root, wikiAnchorGitTimeout, "diff", "--name-status", "-M", "--no-color", from, to)
	if err != nil || code != 0 {
		return nil, fmt.Errorf("git diff %s %s failed in %s: %s", shortWikiHash(from), shortWikiHash(to), root, firstNonEmpty(strings.TrimSpace(stderr), errString(err)))
	}
	changes := map[string]wikiGitChange{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) < 2 || fields[0] == "" {
			continue
		}
		status := fields[0][:1]
		switch {
		case status == "R" && len(fields) >= 3:
			changes[fields[1]] = wikiGitChange{status: "R", to: fields[2]}
			changes[fields[2]] = wikiGitChange{status: "A"}
		case status == "C" && len(fields) >= 3:
			changes[fields[2]] = wikiGitChange{status: "A"}
		default:
			changes[fields[1]] = wikiGitChange{status: status}
		}
	}
	return changes, nil
}

// wikiCommitKnown is whether the checkout has the commit.
func wikiCommitKnown(root, sha string) bool {
	if !wikiCommitSha.MatchString(sha) {
		return false
	}
	_, code, _, err := wikiAnchorGit(root, wikiAnchorGitTimeout, "cat-file", "-e", sha+"^{commit}")
	return err == nil && code == 0
}

// wikiSectionPaths are the repository paths a section's sources name: files, and directories.
func wikiSectionPaths(section wikiDocsPlanSection) []string {
	var out []string
	for _, source := range section.Sources.Docs {
		out = append(out, wikiMaintainCleanPath(source.Path))
	}
	for _, source := range section.Sources.Code {
		out = append(out, wikiMaintainCleanPath(source.Path))
	}
	for _, source := range section.Sources.Contracts {
		out = append(out, wikiMaintainCleanPath(source.Path))
	}
	return out
}

// wikiPathNamed is whether a changed path is one the section names: the file itself, or a file under a
// directory it names.
func wikiPathNamed(changed string, named []string) bool {
	for _, path := range named {
		if path == "" {
			continue
		}
		if changed == path || strings.HasPrefix(changed, strings.TrimSuffix(path, "/")+"/") {
			return true
		}
	}
	return false
}

// repoAffected is the written sections whose repository material changed on origin/main since the commit
// each was generated at, and the files they cite that are gone. Sections are taken by the commit they were
// written at: one `git diff --name-status` a commit, its names matched against the paths those sections name; for
// a section a path of which changed, its pieces — what orbit wiki docs build takes of those files — are read at both
// commits and compared. A commit the checkout does not have makes its sections count as changed.
func (r *wikiMaintainRun) repoAffected(docs []wikiDocsPlanDoc, state wikiDocsStateAnswer, head string) ([]wikiMaintainSectionRef, []wikiGonePath, error) {
	shaOf := map[string]map[string]string{}
	for _, doc := range state.Docs {
		shaOf[doc.Slug] = map[string]string{}
		for _, section := range doc.Sections {
			shaOf[doc.Slug][section.Key] = section.RepoSha
		}
	}
	type pending struct {
		ref     wikiMaintainSectionRef
		section wikiDocsPlanSection
		paths   []string
	}
	bySha := map[string][]pending{}
	var shas []string
	for _, doc := range docs {
		for _, section := range doc.Sections {
			sha, written := shaOf[doc.Slug][section.Key]
			paths := wikiSectionPaths(section)
			if !written || sha == head || len(paths) == 0 {
				continue
			}
			if _, seen := bySha[sha]; !seen {
				shas = append(shas, sha)
			}
			bySha[sha] = append(bySha[sha], pending{wikiMaintainSectionRef{doc.Slug, section.Key}, section, paths})
		}
	}
	sort.Strings(shas)
	headRepo := newWikiDocRepo(r.repo.root, head)
	var changed []wikiMaintainSectionRef
	goneSeen := map[string]bool{}
	var gone []wikiGonePath
	for _, sha := range shas {
		sections := bySha[sha]
		if !wikiCommitKnown(r.repo.root, sha) {
			r.say("The checkout does not have commit %s some sections were written at: %s taken as changed.",
				shortWikiHash(sha), wikiCount(len(sections), "section is", "sections are"))
			for _, p := range sections {
				changed = append(changed, p.ref)
			}
			continue
		}
		// Names only, over the whole tree: a rename is found only when git sees both of its ends.
		diff, err := wikiGitChanges(r.repo.root, sha, head)
		if err != nil {
			return nil, nil, err
		}
		if len(diff) == 0 {
			continue
		}
		baseRepo := newWikiDocRepo(r.repo.root, sha)
		for _, p := range sections {
			touched := false
			for path, change := range diff {
				if !wikiPathNamed(path, p.paths) {
					continue
				}
				touched = true
				if (change.status == "D" || change.status == "R") && !goneSeen[path] {
					goneSeen[path] = true
					entry := wikiGonePath{Path: path, Change: "deleted"}
					if change.status == "R" {
						to := change.to
						entry.Change, entry.To = "renamed", &to
					}
					gone = append(gone, entry)
				}
			}
			if !touched {
				continue
			}
			before, _ := wikiDocRepoPieces(baseRepo, p.section)
			after, _ := wikiDocRepoPieces(headRepo, p.section)
			if !wikiSamePieces(before, after) {
				changed = append(changed, p.ref)
			}
		}
	}
	sort.Slice(gone, func(i, j int) bool { return gone[i].Path < gone[j].Path })
	return changed, gone, nil
}

// wikiSamePieces is whether two readings of a section's repository material say the same: the same pieces,
// of the same files, sections and symbols, with the same words — wherever in the file they now stand.
func wikiSamePieces(a, b []*wikiDocPiece) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].kind != b[i].kind || a[i].path != b[i].path || a[i].section != b[i].section || a[i].symbol != b[i].symbol || a[i].text != b[i].text {
			return false
		}
	}
	return true
}

// ── Design documents new on origin/main ─────────────────────────────────────────────────────────

// wikiNewDesignDoc is a design document origin/main has that it did not at the plan's commit, and no section cites.
type wikiNewDesignDoc struct {
	Path        string
	RenamedFrom string
	Commit      string
	Title       string
	Headings    []string
	Opening     string
}

var (
	wikiDesignHeading = regexp.MustCompile(`^(#{1,3})\s+(.+?)\s*#*\s*$`)
	wikiDesignFence   = regexp.MustCompile("^\\s*(```|~~~)")
)

// newDesignDocs is every Markdown file under docs/ — outside docs/mocks and docs/evidence — that origin/main
// added, or renamed into place, since the commit the plan's references were checked at, that no section of
// the plan cites and no proposal names; each with the commit that added it, its title, headings and opening.
func (r *wikiMaintainRun) newDesignDocs(base, head string, cited map[string]bool) []wikiNewDesignDoc {
	if base == "" || !wikiCommitKnown(r.repo.root, base) {
		if base != "" {
			r.say("The checkout does not have commit %s the plan's references were checked at: no design document is taken as new.", shortWikiHash(base))
		}
		return nil
	}
	out, code, _, err := wikiAnchorGit(r.repo.root, wikiAnchorGitTimeout, "diff", "--name-status", "-M", "--no-color", "--diff-filter=AR", base, head, "--", "docs/")
	if err != nil || code != 0 {
		return nil
	}
	var docs []wikiNewDesignDoc
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) < 2 {
			continue
		}
		doc := wikiNewDesignDoc{Path: fields[len(fields)-1]}
		if strings.HasPrefix(fields[0], "R") && len(fields) >= 3 {
			doc.RenamedFrom = fields[1]
		}
		if !strings.HasSuffix(strings.ToLower(doc.Path), ".md") || cited[doc.Path] {
			continue
		}
		excluded := false
		for _, dir := range wikiMaintainDocsExcluded {
			excluded = excluded || strings.HasPrefix(doc.Path, dir)
		}
		if excluded {
			continue
		}
		commit, code, _, err := wikiAnchorGit(r.repo.root, wikiAnchorGitTimeout, "log", "-1", "--format=%H", "--diff-filter=AR", base+".."+head, "--", doc.Path)
		doc.Commit = strings.TrimSpace(string(commit))
		if err != nil || code != 0 || !wikiCommitSha.MatchString(doc.Commit) {
			doc.Commit = head
		}
		content, code, _, err := wikiAnchorGit(r.repo.root, wikiAnchorGitTimeout, "show", head+":"+doc.Path)
		if err != nil || code != 0 {
			continue
		}
		doc.Title, doc.Headings, doc.Opening = wikiDesignOutline(string(content))
		docs = append(docs, doc)
	}
	sort.Slice(docs, func(i, j int) bool { return docs[i].Path < docs[j].Path })
	if len(docs) > 0 {
		r.say("New design documents no section of the plan cites: %s.", strings.Join(wikiDesignPaths(docs), ", "))
	}
	return docs
}

func wikiDesignPaths(docs []wikiNewDesignDoc) []string {
	var out []string
	for _, doc := range docs {
		out = append(out, doc.Path)
	}
	return out
}

// wikiDesignOutline is a Markdown document's title (its first heading), its headings to level 3 outside
// code fences, and its first paragraph that says something, cut.
func wikiDesignOutline(content string) (string, []string, string) {
	title, opening := "", ""
	var headings []string
	fence := false
	var paragraph []string
	flush := func() {
		text := strings.Join(strings.Fields(strings.Join(paragraph, " ")), " ")
		paragraph = nil
		if opening == "" && len([]rune(text)) >= 20 && !strings.HasPrefix(text, "|") {
			opening = cutRunes(text, 400)
		}
	}
	for _, line := range strings.Split(content, "\n") {
		if wikiDesignFence.MatchString(line) {
			fence = !fence
			flush()
			continue
		}
		if fence {
			continue
		}
		if m := wikiDesignHeading.FindStringSubmatch(line); m != nil {
			flush()
			if title == "" {
				title = strings.TrimSpace(m[2])
			} else if len(headings) < 30 {
				headings = append(headings, strings.Repeat("#", len(m[1]))+" "+strings.TrimSpace(m[2]))
			}
			continue
		}
		if strings.TrimSpace(line) == "" {
			flush()
			continue
		}
		paragraph = append(paragraph, strings.TrimSpace(line))
	}
	flush()
	return title, headings, opening
}

// ── The plan proposal ───────────────────────────────────────────────────────────────────────────

// wikiProposalItem is one piece of knowledge the plan has no place for, as the model is told it.
type wikiProposalItem struct {
	ID     string // K1, K2, …
	design *wikiNewDesignDoc
	entry  *wikiUnplacedEntry
}

// wikiProposalAnswer is the model's answer, read.
type wikiProposalAnswer struct {
	Target   string // a document's slug, or "" for a new one
	NewDoc   bool
	Reason   string
	Covers   []string
	Category string
	Slug     string
	Header   wikiPlanHeader
	Sections []wikiPlanSectionDraft
	Stray    []string
}

// proposePlanChange makes the run's one proposal: the model says where the knowledge belongs, the run
// checks it on origin/main and against the space's topics, and the server's gate checks the rest, three
// rounds at most.
func (r *wikiMaintainRun) proposePlanChange(plan wikiPlanVersionRead, designs []wikiNewDesignDoc, entries []wikiUnplacedEntry, head string, topics []wikiPlanTopic) *wikiMaintainProposalReport {
	var items []wikiProposalItem
	for i := range designs {
		if len(items) == wikiMaintainProposalItemsMax {
			break
		}
		items = append(items, wikiProposalItem{ID: "K" + strconv.Itoa(len(items)+1), design: &designs[i]})
	}
	for i := range entries {
		if len(items) == wikiMaintainProposalItemsMax {
			break
		}
		items = append(items, wikiProposalItem{ID: "K" + strconv.Itoa(len(items)+1), entry: &entries[i]})
	}
	out := &wikiMaintainProposalReport{Outcome: "failed"}
	if r.claude == "" {
		if err := r.model(); err != nil {
			out.Error = cutRunes(err.Error(), 400)
			return out
		}
	}
	repo := newWikiDocRepo(r.repo.root, head)
	prompt := wikiProposalPrompt(plan, items)
	var problems []string
	for round := 1; round <= wikiMaintainProposalRoundsMax; round++ {
		out.Rounds = round
		asked := prompt
		if len(problems) > 0 {
			asked += wikiProposalRedo(problems)
		}
		text, err := r.askAs(wikiPlanSystemPrompt, asked)
		if err != nil {
			out.Error = cutRunes(err.Error(), 400)
			return out
		}
		answer := parseWikiProposal(text)
		request, check := assembleWikiProposal(plan, answer, items, repo, topics)
		if len(check) > 0 {
			problems = check
			r.say("  proposal round %d: %s found here: %s", round, wikiCount(len(check), "problem", "problems"), cutRunes(strings.Join(check, "; "), 300))
			continue
		}
		raw, err := r.t.proposeWikiPlanChange(r.sessionID, r.spaceID, request)
		if err != nil {
			if refusal, ok := wikiPlanGateRefused(err); ok {
				problems = nil
				for _, e := range refusal.Errors {
					problems = append(problems, e.Path+": "+e.Message)
				}
				r.say("  proposal round %d: the server's gate found %s", round, wikiCount(len(problems), "error", "errors"))
				continue
			}
			out.Error = cutRunes(wikiMaintenanceCallError("orbit wiki maintain", r.spaceID, "--space", err).Error(), 400)
			return out
		}
		var stored struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(raw, &stored)
		out.Outcome, out.ID, out.Doc, out.NewDoc, out.Facts = "proposed", stored.ID, request.Change.Doc.Slug, answer.NewDoc, len(request.Facts)
		out.Reason = cutRunes(request.Reason, 400)
		r.say("Proposed a change to the plan (%s): %s «%s», from %s — %s", out.ID, map[bool]string{true: "a new document", false: "document"}[answer.NewDoc],
			request.Change.Doc.Slug, wikiCount(len(request.Facts), "fact", "facts"), cutRunes(request.Reason, 200))
		return out
	}
	out.Error = cutRunes("the proposal did not pass in "+strconv.Itoa(wikiMaintainProposalRoundsMax)+" rounds: "+strings.Join(problems, "; "), 600)
	r.say("No proposal: %s", out.Error)
	return out
}

// wikiProposalPrompt asks the model where the knowledge the plan has no place for belongs.
func wikiProposalPrompt(plan wikiPlanVersionRead, items []wikiProposalItem) string {
	var knowledge strings.Builder
	for _, item := range items {
		switch {
		case item.design != nil:
			d := item.design
			fmt.Fprintf(&knowledge, "[%s] new design doc %s", item.ID, d.Path)
			if d.Title != "" {
				fmt.Fprintf(&knowledge, " «%s»", d.Title)
			}
			fmt.Fprintf(&knowledge, " (added to origin/main in commit %s", shortWikiHash(d.Commit))
			if d.RenamedFrom != "" {
				fmt.Fprintf(&knowledge, ", renamed from %s", d.RenamedFrom)
			}
			knowledge.WriteString(")\n")
			if d.Opening != "" {
				fmt.Fprintf(&knowledge, "    Opening: %s\n", d.Opening)
			}
			if len(d.Headings) > 0 {
				fmt.Fprintf(&knowledge, "    Sections: %s\n", strings.Join(d.Headings, "; "))
			}
		case item.entry != nil:
			e := item.entry
			fmt.Fprintf(&knowledge, "[%s] entry (%s) «%s»: %s", item.ID, e.Kind, e.Title, e.Summary)
			if len(e.AnchorPaths) > 0 {
				fmt.Fprintf(&knowledge, "; anchors %s", strings.Join(e.AnchorPaths, ", "))
			}
			if len(e.Topics) > 0 {
				fmt.Fprintf(&knowledge, "; topics %s", strings.Join(e.Topics, ", "))
			}
			knowledge.WriteString("\n")
		}
	}
	var catalogue strings.Builder
	for _, category := range plan.Categories {
		fmt.Fprintf(&catalogue, "## Category `%s` «%s»", category.Key, category.Title)
		if category.Question != "" {
			fmt.Fprintf(&catalogue, " — %s", category.Question)
		}
		catalogue.WriteString("\n")
		for _, doc := range plan.Docs {
			if doc.Category != category.Key {
				continue
			}
			var titles []string
			for n, section := range doc.Sections {
				titles = append(titles, fmt.Sprintf("%d.%s (%s)", n+1, section.Title, section.Kind))
			}
			fmt.Fprintf(&catalogue, "- `%s` «%s» | %s | Includes: %s\n  Sections: %s\n", doc.Slug, doc.Title, doc.Question, strings.Join(doc.ScopeIn, "; "),
				strings.Join(titles, " "))
		}
	}
	return `
# Task: the maintenance run's proposed change to the plan
This wiki's documents are written section by section to the plan the owner confirmed (version ` + strconv.Itoa(plan.Version) + `; its catalogue is below). The maintenance run found some new knowledge that no section of the plan covers ("New knowledge" below).
From it, pick one group that belongs together — a few items about the same thing, which read coherently in one place (at least one item; if no group can be picked, pick just one; when there is a new design document, consider it first) — and propose which document of the plan it goes into: an existing document (adding a section or a few to it), or a new one.
New knowledge that is not about the same thing as this group is not placed this time; leave it for the next maintenance run to propose: do not put unrelated knowledge together into one document or one section to place it all at once, and do not add a document with no specific subject, such as "Miscellaneous", "Other" or "Loose entries". Do not change any other document, and do not delete a section.

## New knowledge
` + knowledge.String() + `
## The plan's catalogue
` + catalogue.String() + `
## Where each section's material comes from
- A section on a mechanism (concepts / flow / interface / data / ops): its sources are the design documents and the code. For a new design document, write "- Docs: <path> § <section heading>", with the section heading copied exactly from those listed above; without §, it is the whole document.
- Known pitfalls, decisions and reasons, conventions (pitfalls / decisions / conventions): its source is the conditions to find the words in sessions by, "- Sessions: keywords <word>, <word>; anchors <path prefix>; kind <pitfall/decision/convention/…>; topics <slug>; look for: <what kind of original words to look for>". Choose keywords that really appear in the entries of the new knowledge.
- Use only the paths, section headings and topics that appear above; invent none.

## Output format
Output only what follows, with no preamble, no summary and no JSON:
Into: <the slug of an existing document, copied exactly from between the backticks in the catalogue> (or write "Into: new")
Reason: <a sentence or two: what the new knowledge is, and why it goes here>
Uses: <the numbers of the new knowledge this proposal uses, such as K1, K3>
For a new document, also write these lines:
Category: <the key of a category in the catalogue>
slug: <the new document's slug: lowercase letters and digits, joined by hyphens>
Title: <title>
Question: <the question the reader comes with, in one sentence>
Audience: <who>: <what they can do once they have read it>
Includes: <point>; <point>
Length: <a–b characters>
Then write the sections to add, one or a few:
### 1. <section title> | <type> | <length in characters>
Covers: <what exactly this section says, in 1–2 sentences>
- Docs: <docs/….md> § <section heading>
- Sessions: keywords …; anchors …; kind …; topics …; look for: …
`
}

// wikiProposalRedo hands back what was wrong with the last answer.
func wikiProposalRedo(problems []string) string {
	listed := problems
	if len(listed) > 30 {
		listed = listed[:30]
	}
	return "\n## The last answer had these problems: correct them, and write the whole answer again in the same format\n- " + strings.Join(listed, "\n- ") + "\n"
}

// parseWikiProposal reads the model's answer: its own lines first, then a document's header and sections
// in the plan's line format (parseWikiPlanDocBody).
func parseWikiProposal(text string) wikiProposalAnswer {
	var answer wikiProposalAnswer
	var rest []string
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(raw), "-*•"))
		label, value := wikiPlanLabel(line)
		switch strings.ToLower(label) {
		case "into":
			value = strings.Trim(value, "`「」《》«» ")
			if lower := strings.ToLower(value); lower == "new" || strings.HasPrefix(lower, "new ") {
				answer.NewDoc = true
			} else {
				answer.Target = value
			}
			continue
		case "reason":
			answer.Reason = value
			continue
		case "uses":
			answer.Covers = regexp.MustCompile(`K\d+`).FindAllString(strings.ToUpper(value), -1)
			continue
		case "category":
			answer.Category = strings.Trim(value, "`「」 ")
			continue
		case "slug":
			answer.Slug = strings.Trim(value, "`「」 ")
			continue
		}
		rest = append(rest, raw)
	}
	answer.Header, answer.Sections, answer.Stray = parseWikiPlanDocBody(strings.Join(rest, "\n"))
	return answer
}

// assembleWikiProposal turns the answer into the proposal the server gates: the document as it should read
// — the plan's own, with the new sections after its last, or a new one — and the facts it came from. What
// is wrong with it that this runner can see — a missing line, a kind the plan does not have, a file,
// document section, symbol or contract origin/main does not have, a topic the space does not have (topics,
// the space's: nil leaves them to the server's gate) — comes back as problems, for the model.
func assembleWikiProposal(plan wikiPlanVersionRead, answer wikiProposalAnswer, items []wikiProposalItem, repo *wikiDocRepo, topics []wikiPlanTopic) (wikiPlanProposalRequest, []string) {
	var problems []string
	var request wikiPlanProposalRequest
	if strings.TrimSpace(answer.Reason) == "" {
		problems = append(problems, "the Reason line is missing: say what the new knowledge is, and why it goes here")
	}
	byID := map[string]wikiProposalItem{}
	for _, item := range items {
		byID[item.ID] = item
	}
	var facts []wikiPlanFact
	seen := map[string]bool{}
	for _, id := range answer.Covers {
		item, ok := byID[id]
		if !ok {
			problems = append(problems, fmt.Sprintf("%s on the Uses line is not the number of an item of new knowledge", wikiQuote(id)))
			continue
		}
		var fact wikiPlanFact
		if item.design != nil {
			fact = wikiPlanFact{Kind: "commit", ID: item.design.Commit}
		} else {
			fact = wikiPlanFact{Kind: "entry", ID: item.entry.ID}
		}
		if !seen[fact.Kind+fact.ID] {
			seen[fact.Kind+fact.ID] = true
			facts = append(facts, fact)
		}
	}
	if len(facts) == 0 {
		problems = append(problems, "the Uses line is missing: list the numbers of the new knowledge this proposal uses, such as K1, K2")
	}
	if len(answer.Sections) == 0 {
		problems = append(problems, "there is no section to add: write one at least, \"### 1. <section title> | <type> | <length in characters>\"")
	}
	var sections []wikiPlanSection
	for i, draft := range answer.Sections {
		section, check := wikiProposalSection(fmt.Sprintf("section %d", i+1), draft, repo, topics)
		problems = append(problems, check...)
		sections = append(sections, section)
	}
	for _, line := range answer.Stray {
		problems = append(problems, fmt.Sprintf("%s is not a line of this format: drop it", wikiQuote(cutRunes(line, 60))))
	}
	var doc wikiPlanDoc
	var category *wikiPlanCategory
	switch {
	case answer.NewDoc:
		h := answer.Header
		doc = wikiPlanDoc{Category: answer.Category, Slug: answer.Slug, Title: h.Title, Question: h.Question,
			Audience: h.Audience, ScopeIn: h.ScopeIn, ScopeOut: []wikiPlanScopeOut{}}
		known := false
		for _, c := range plan.Categories {
			known = known || c.Key == answer.Category
		}
		if !known {
			problems = append(problems, fmt.Sprintf("Category %s is not a category of the catalogue: copy a category's key exactly", wikiQuote(answer.Category)))
		}
		if !wikiSlugPattern.MatchString(answer.Slug) {
			problems = append(problems, fmt.Sprintf("slug %s is not a slug: lowercase letters and digits, joined by hyphens", wikiQuote(answer.Slug)))
		}
		for _, existing := range plan.Docs {
			if existing.Slug == answer.Slug {
				problems = append(problems, fmt.Sprintf("slug %s is an existing document already: a new document takes a new slug, and to add to the existing one, "+
					"write \"Into: %s\"", wikiQuote(answer.Slug), answer.Slug))
			}
		}
		if h.Title == "" || h.Question == "" || len(h.Audience) == 0 || len(h.ScopeIn) == 0 {
			problems = append(problems, "a new document needs all five lines: Title, Question, Audience, Includes and Length")
		}
		if min, max, ok := wikiPlanRange(h.Length); ok {
			doc.Length = wikiPlanLength{Min: min, Max: max}
		} else {
			problems = append(problems, fmt.Sprintf("Length %s is not a length: write it as <a–b characters>", wikiQuote(h.Length)))
		}
		doc.Sections = sections
	default:
		var target *wikiPlanDocRead
		for i := range plan.Docs {
			if plan.Docs[i].Slug == answer.Target {
				target = &plan.Docs[i]
			}
		}
		if target == nil {
			problems = append(problems, fmt.Sprintf("Into %s is not a document of the catalogue: copy a document's slug exactly, or write \"Into: new\"", wikiQuote(answer.Target)))
			break
		}
		if target.Protected {
			problems = append(problems, fmt.Sprintf("%s is a protected document and does not change: put it into another document, or add a new one", target.Slug))
		}
		doc = wikiPlanDocInput(*target)
		doc.Protected = false
		doc.Sections = append(doc.Sections, sections...)
	}
	request = wikiPlanProposalRequest{Reason: cutRunes(strings.TrimSpace(answer.Reason), 2000), Change: wikiPlanChange{Doc: doc, Category: category}, Facts: facts}
	return request, problems
}

// wikiProposalSection is one new section as the model wrote it, checked against origin/main: its kind, its
// length, and every file, document section, symbol and contract it names; and its topics among the space's.
func wikiProposalSection(at string, draft wikiPlanSectionDraft, repo *wikiDocRepo, topics []wikiPlanTopic) (wikiPlanSection, []string) {
	var problems []string
	section := wikiPlanSection{Title: draft.Title, Kind: wikiUnwrap(draft.Kind), Covers: draft.Covers}
	if !contains(wikiPlanSectionKinds, section.Kind) {
		problems = append(problems, fmt.Sprintf("%s: the type %s is not a section type: one of %s", at, wikiQuote(section.Kind), strings.Join(wikiPlanSectionKinds, ", ")))
	}
	if min, _, ok := wikiPlanRange(draft.Length); ok {
		section.Length = min
	} else {
		problems = append(problems, fmt.Sprintf("%s: the length %s is not a number", at, wikiQuote(draft.Length)))
	}
	if strings.TrimSpace(draft.Covers) == "" {
		problems = append(problems, fmt.Sprintf("%s has no Covers line", at))
	}
	section.Sources.Docs = append([]wikiPlanDocSource{}, draft.Docs...)
	section.Sources.Code = append([]wikiPlanCodeSource{}, draft.Code...)
	section.Sources.Contracts = []wikiPlanContractSource{}
	for _, path := range draft.Contracts {
		section.Sources.Contracts = append(section.Sources.Contracts, wikiPlanContractSource{Path: path})
	}
	for _, source := range draft.Docs {
		heading := ""
		if source.Section != nil {
			heading = *source.Section
		}
		if _, ok := repo.docSection(source.Path, heading); !ok {
			if _, exists := repo.show(source.Path); !exists {
				problems = append(problems, fmt.Sprintf("%s: the document %s is not on origin/main", at, wikiQuote(source.Path)))
			} else {
				problems = append(problems, fmt.Sprintf("%s: the document %s has no section %s: copy a section heading the new knowledge lists exactly, "+
					"or write no §", at, source.Path, wikiQuote(heading)))
			}
		}
	}
	for _, source := range draft.Code {
		if _, missing := repo.codePieces(source.Path, source.Symbols, nil); len(missing) > 0 {
			problems = append(problems, fmt.Sprintf("%s: code not found on origin/main: %s", at, strings.Join(missing, ", ")))
		}
	}
	for _, path := range draft.Contracts {
		if _, ok := repo.contract(path); !ok {
			problems = append(problems, fmt.Sprintf("%s: the contract %s is not on origin/main", at, wikiQuote(path)))
		}
	}
	if c := draft.Sessions; c != nil {
		sessions := &wikiPlanSessions{Projects: c.Projects, Keywords: c.Keywords, AnchorPaths: c.AnchorPaths, EntryKinds: wikiUnwrapAll(c.EntryKinds),
			Topics: wikiUnwrapAll(c.Topics), Evidence: c.Evidence}
		if c.Since != "" {
			since := c.Since
			sessions.Since = &since
		}
		if c.Until != "" {
			until := c.Until
			sessions.Until = &until
		}
		for _, part := range c.Stray {
			problems = append(problems, fmt.Sprintf("%s: %s is not a part of a session condition: it has projects, dates, keywords, "+
				"anchors, kinds, topics and what to look for — drop it", at, wikiQuote(cutRunes(part, 60))))
		}
		// The server's gate takes a topic only from the space's (plan.gate.references), and lists them with one it
		// refuses: so is it here, and listed the same, so the round that refuses it can fix it. A document's slug
		// passed here until 2026-10-10 and was refused at the gate in the run's last round (canary 3b2bd5f2).
		if topics != nil {
			known := map[string]bool{}
			for _, t := range topics {
				known[t.Slug] = true
			}
			for _, topic := range sessions.Topics {
				if !known[topic] {
					problems = append(problems, fmt.Sprintf("%s: %s is not a topic of this space: %s", at, wikiQuote(topic), wikiPlanTopicsBrief(topics)))
				}
			}
		}
		section.Sources.Sessions = sessions
	}
	if len(section.Sources.Docs)+len(section.Sources.Code)+len(section.Sources.Contracts) == 0 && section.Sources.Sessions == nil {
		problems = append(problems, fmt.Sprintf("%s names no sources: a section on a mechanism names its design documents and code, one on pitfalls, "+
			"decisions or conventions the sessions to find the words in", at))
	}
	for _, line := range draft.Stray {
		problems = append(problems, fmt.Sprintf("%s: %s is not a line of a section: a section has what it covers, its documents, "+
			"code, contracts and sessions, and nothing else — drop it", at, wikiQuote(cutRunes(line, 60))))
	}
	return section, problems
}

// askAs is one clean call with its own system prompt, counted and tried again as ask is.
func (r *wikiMaintainRun) askAs(system, prompt string) (string, error) {
	var last error
	for _, wait := range wikiArticleRetryWaits {
		time.Sleep(wait)
		ctx, cancel := context.WithTimeout(context.Background(), wikiArticleCallTimeout)
		text, usage, err := askWikiModel(ctx, r.claude, r.cfg, system, prompt)
		cancel()
		r.mu.Lock()
		r.report.Tokens.Calls++
		r.report.Tokens.Input += usage.InputTokens
		r.report.Tokens.Output += usage.OutputTokens
		r.mu.Unlock()
		if err == nil {
			return text, nil
		}
		var auth *wikiArticleAuthError
		if errors.As(err, &auth) {
			return "", &wikiMaintainAuthError{detail: auth.detail}
		}
		last = err
	}
	return "", last
}

// describeWikiMaintainDocs is the documents' lines of the run's summary.
func describeWikiMaintainDocs(d *wikiMaintainDocsReport) string {
	var b strings.Builder
	switch {
	case d.Skipped == "no_confirmed_plan":
		b.WriteString("\n- documents: no confirmed plan — no document was written; the owner confirms a plan first")
		return b.String()
	case d.Skipped == "no_server_support":
		b.WriteString("\n- documents: this Orbit server predates the documents' maintenance — none was written")
		return b.String()
	case d.Skipped == "catching_up":
		b.WriteString("\n- documents: the space is catching up — none was written and no change to the plan proposed; the " +
			"first run after it has caught up writes what changed meanwhile")
		return b.String()
	case d.PlanVersion == nil:
		fmt.Fprintf(&b, "\n- documents: not written — %s", d.Error)
		return b.String()
	}
	fmt.Fprintf(&b, "\n- documents (plan version %d, origin/main %s): %d sections to write again — %d by the entries, %d by the "+
		"repository, %d stale, %d never written; %d written, %d unchanged, %d failed; %d model calls, %d tokens in, %d out, %ds",
		*d.PlanVersion, shortWikiHash(d.RepoSha), d.Affected.Total, d.Affected.ByEntries, d.Affected.ByRepo, d.Affected.Stale,
		d.Affected.Unwritten, d.Sections.Written, d.Sections.Unchanged, d.Sections.Failed, d.Tokens.Calls, d.Tokens.Input, d.Tokens.Output, d.Seconds)
	if d.Withdrawn.Paths > 0 {
		fmt.Fprintf(&b, "\n- withdrawn: %d sentences citing %d files gone from origin/main", d.Withdrawn.Sentences, d.Withdrawn.Paths)
	}
	if d.Unplaced.DesignDocs+d.Unplaced.Entries > 0 {
		fmt.Fprintf(&b, "\n- no place in the plan: %d new design documents, %d entries", d.Unplaced.DesignDocs, d.Unplaced.Entries)
	}
	if p := d.Proposal; p != nil {
		if p.Outcome == "proposed" {
			fmt.Fprintf(&b, "\n- plan proposal %s: %s «%s», %d facts, round %d — %s", p.ID, map[bool]string{true: "a new document", false: "document"}[p.NewDoc],
				p.Doc, p.Facts, p.Rounds, p.Reason)
		} else {
			fmt.Fprintf(&b, "\n- plan proposal: none passed — %s", p.Error)
		}
	}
	if d.Error != "" {
		fmt.Fprintf(&b, "\n- documents stopped: %s", d.Error)
	}
	return b.String()
}
