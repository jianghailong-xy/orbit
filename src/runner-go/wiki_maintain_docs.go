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
		report.Proposal = r.proposePlanChange(*full.Confirmed, designs, affected.Unplaced, head)
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
// checks it on origin/main and the server's gate checks the rest, three rounds at most.
func (r *wikiMaintainRun) proposePlanChange(plan wikiPlanVersionRead, designs []wikiNewDesignDoc, entries []wikiUnplacedEntry, head string) *wikiMaintainProposalReport {
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
		request, check := assembleWikiProposal(plan, answer, items, repo)
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
			fmt.Fprintf(&knowledge, "[%s] 新设计文档 %s", item.ID, d.Path)
			if d.Title != "" {
				fmt.Fprintf(&knowledge, "「%s」", d.Title)
			}
			fmt.Fprintf(&knowledge, "（提交 %s 加入 origin/main", shortWikiHash(d.Commit))
			if d.RenamedFrom != "" {
				fmt.Fprintf(&knowledge, "，由 %s 改名而来", d.RenamedFrom)
			}
			knowledge.WriteString("）\n")
			if d.Opening != "" {
				fmt.Fprintf(&knowledge, "    开头：%s\n", d.Opening)
			}
			if len(d.Headings) > 0 {
				fmt.Fprintf(&knowledge, "    章节：%s\n", strings.Join(d.Headings, "；"))
			}
		case item.entry != nil:
			e := item.entry
			fmt.Fprintf(&knowledge, "[%s] 条目（%s）「%s」：%s", item.ID, e.Kind, e.Title, e.Summary)
			if len(e.AnchorPaths) > 0 {
				fmt.Fprintf(&knowledge, "；锚点 %s", strings.Join(e.AnchorPaths, "、"))
			}
			if len(e.Topics) > 0 {
				fmt.Fprintf(&knowledge, "；主题 %s", strings.Join(e.Topics, "、"))
			}
			knowledge.WriteString("\n")
		}
	}
	var catalogue strings.Builder
	for _, category := range plan.Categories {
		fmt.Fprintf(&catalogue, "## 大类 `%s`「%s」", category.Key, category.Title)
		if category.Question != "" {
			fmt.Fprintf(&catalogue, " —— %s", category.Question)
		}
		catalogue.WriteString("\n")
		for _, doc := range plan.Docs {
			if doc.Category != category.Key {
				continue
			}
			var titles []string
			for n, section := range doc.Sections {
				titles = append(titles, fmt.Sprintf("%d.%s（%s）", n+1, section.Title, section.Kind))
			}
			fmt.Fprintf(&catalogue, "- `%s`《%s》｜%s｜含：%s\n  各节：%s\n", doc.Slug, doc.Title, doc.Question, strings.Join(doc.ScopeIn, "；"), strings.Join(titles, " "))
		}
	}
	return `
# 任务：维护作业的 plan 修改建议
这个 wiki 的文档按 owner 确认的 plan（第 ` + strconv.Itoa(plan.Version) + ` 版，目录见下）逐节写。维护作业找到了一些新知识，plan 里没有任何一节讲它们（下面「新知识」）。
请从中挑出能放在一起的一组——讲同一件事、放在同一处读起来连贯的几条（至少一条，挑不出就只挑一条；有新设计文档时先考虑它），建议放进 plan 的哪一篇：放进现有的一篇（给它加一节或几节），或者新增一篇。
和这一组讲的不是同一件事的新知识，这次不要放，留给下一次维护作业再提：不要为了一次放完，把不相干的知识凑进同一篇或同一节，也不要新增「杂项」「其他」「散落条目」这类没有具体主题的篇。不要改动别的篇，也不要删节。

## 新知识
` + knowledge.String() + `
## plan 的目录
` + catalogue.String() + `
## 每一节的材料来源
- 讲机制的节（concepts / flow / interface / data / ops）：出处写设计文档和代码。新设计文档写「- 文档：<路径> § <章节标题>」，章节标题原样抄上面列出的；不写 § 就是整篇。
- 已知的坑、决策与理由、约定（pitfalls / decisions / conventions）：出处写去会话里找原话的条件「- 会话：关键词 <词>、<词>；锚点 <路径前缀>；kind <pitfall/decision/convention/…>；主题 <slug>；要找：<要找什么样的原文>」。关键词要选新知识条目里确实出现的词。
- 只用上面出现过的路径、章节标题和主题；不要编造。

## 输出格式
只输出下面的内容，不要前言和总结，不要 JSON：
放入：<现有一篇的 slug，原样抄目录里反引号中的>（或者写「放入：新篇」）
理由：<一两句：新知识是什么，为什么放在这里>
覆盖：<这条建议用到的新知识编号，如 K1、K3>
如果是新篇，再写这几行：
大类：<目录里一个大类的 key>
slug：<新篇的 slug：小写字母、数字，用连字符连接>
标题：<中文标题>
问题：<读者带着什么问题来，一句话>
读者：<谁>：<读完能做什么>
含：<要点>；<要点>
篇幅：<a–b 字>
然后写要新增的节，一节或几节：
### 1. <节标题> | <type> | <中文字数>
讲什么：<这一节具体讲什么，1–2 句>
- 文档：<docs/….md> § <章节标题>
- 会话：关键词 …；锚点 …；kind …；主题 …；要找：…
`
}

// wikiProposalRedo hands back what was wrong with the last answer.
func wikiProposalRedo(problems []string) string {
	listed := problems
	if len(listed) > 30 {
		listed = listed[:30]
	}
	return "\n## 上一次的答案有这些问题，请改正后按同样的格式重写整个答案\n- " + strings.Join(listed, "\n- ") + "\n"
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
		case "放入":
			value = strings.Trim(value, "`「」《》 ")
			if strings.Contains(value, "新篇") || strings.EqualFold(value, "new") {
				answer.NewDoc = true
			} else {
				answer.Target = value
			}
			continue
		case "理由":
			answer.Reason = value
			continue
		case "覆盖":
			answer.Covers = regexp.MustCompile(`K\d+`).FindAllString(strings.ToUpper(value), -1)
			continue
		case "大类":
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
// document section, symbol or contract origin/main does not have — comes back as problems, for the model.
func assembleWikiProposal(plan wikiPlanVersionRead, answer wikiProposalAnswer, items []wikiProposalItem, repo *wikiDocRepo) (wikiPlanProposalRequest, []string) {
	var problems []string
	var request wikiPlanProposalRequest
	if strings.TrimSpace(answer.Reason) == "" {
		problems = append(problems, "「理由」一行缺了：写明新知识是什么、为什么放在这里")
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
			problems = append(problems, fmt.Sprintf("「覆盖」里的 %s 不是新知识的编号", id))
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
		problems = append(problems, "「覆盖」一行缺了：列出这条建议用到的新知识编号，如 K1、K2")
	}
	if len(answer.Sections) == 0 {
		problems = append(problems, "没有要新增的节：至少写一节「### 1. <节标题> | <type> | <中文字数>」")
	}
	var sections []wikiPlanSection
	for i, draft := range answer.Sections {
		section, check := wikiProposalSection(fmt.Sprintf("第 %d 节", i+1), draft, repo)
		problems = append(problems, check...)
		sections = append(sections, section)
	}
	for _, line := range answer.Stray {
		problems = append(problems, fmt.Sprintf("「%s」不是这个格式里的一行：删掉它", cutRunes(line, 60)))
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
			problems = append(problems, fmt.Sprintf("「大类：%s」不是目录里的大类：原样抄一个大类的 key", answer.Category))
		}
		if !wikiSlugPattern.MatchString(answer.Slug) {
			problems = append(problems, fmt.Sprintf("「slug：%s」不是 slug：小写字母和数字，用连字符连接", answer.Slug))
		}
		for _, existing := range plan.Docs {
			if existing.Slug == answer.Slug {
				problems = append(problems, fmt.Sprintf("slug %s 已经是现有的一篇：新篇要用新的 slug，放进现有的一篇就写「放入：%s」", answer.Slug, answer.Slug))
			}
		}
		if h.Title == "" || h.Question == "" || len(h.Audience) == 0 || len(h.ScopeIn) == 0 {
			problems = append(problems, "新篇要写全「标题」「问题」「读者」「含」「篇幅」五行")
		}
		if min, max, ok := wikiPlanRange(h.Length); ok {
			doc.Length = wikiPlanLength{Min: min, Max: max}
		} else {
			problems = append(problems, fmt.Sprintf("「篇幅：%s」不是篇幅：写成 <a–b 字>", h.Length))
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
			problems = append(problems, fmt.Sprintf("「放入：%s」不是目录里的一篇：原样抄一篇的 slug，或写「放入：新篇」", answer.Target))
			break
		}
		if target.Protected {
			problems = append(problems, fmt.Sprintf("%s 是受保护的篇，不能改：放进别的篇，或新增一篇", target.Slug))
		}
		doc = wikiPlanDocInput(*target)
		doc.Protected = false
		doc.Sections = append(doc.Sections, sections...)
	}
	request = wikiPlanProposalRequest{Reason: cutRunes(strings.TrimSpace(answer.Reason), 2000), Change: wikiPlanChange{Doc: doc, Category: category}, Facts: facts}
	return request, problems
}

// wikiProposalSection is one new section as the model wrote it, checked against origin/main: its kind, its
// length, and every file, document section, symbol and contract it names.
func wikiProposalSection(at string, draft wikiPlanSectionDraft, repo *wikiDocRepo) (wikiPlanSection, []string) {
	var problems []string
	section := wikiPlanSection{Title: draft.Title, Kind: draft.Kind, Covers: draft.Covers}
	if !contains(wikiPlanSectionKinds, draft.Kind) {
		problems = append(problems, fmt.Sprintf("%s的 type「%s」不是节的类型：%s 之一", at, draft.Kind, strings.Join(wikiPlanSectionKinds, "、")))
	}
	if min, _, ok := wikiPlanRange(draft.Length); ok {
		section.Length = min
	} else {
		problems = append(problems, fmt.Sprintf("%s的字数「%s」不是数字", at, draft.Length))
	}
	if strings.TrimSpace(draft.Covers) == "" {
		problems = append(problems, fmt.Sprintf("%s缺「讲什么」", at))
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
				problems = append(problems, fmt.Sprintf("%s的文档 %s 在 origin/main 上没有", at, source.Path))
			} else {
				problems = append(problems, fmt.Sprintf("%s的文档 %s 里没有章节「%s」：原样抄新知识里列出的章节标题，或不写 §", at, source.Path, heading))
			}
		}
	}
	for _, source := range draft.Code {
		if _, missing := repo.codePieces(source.Path, source.Symbols, nil); len(missing) > 0 {
			problems = append(problems, fmt.Sprintf("%s的代码在 origin/main 上找不到：%s", at, strings.Join(missing, "、")))
		}
	}
	for _, path := range draft.Contracts {
		if _, ok := repo.contract(path); !ok {
			problems = append(problems, fmt.Sprintf("%s的契约 %s 在 origin/main 上没有", at, path))
		}
	}
	if c := draft.Sessions; c != nil {
		sessions := &wikiPlanSessions{Projects: c.Projects, Keywords: c.Keywords, AnchorPaths: c.AnchorPaths, EntryKinds: c.EntryKinds, Topics: c.Topics, Evidence: c.Evidence}
		if c.Since != "" {
			since := c.Since
			sessions.Since = &since
		}
		if c.Until != "" {
			until := c.Until
			sessions.Until = &until
		}
		for _, part := range c.Stray {
			problems = append(problems, fmt.Sprintf("%s的会话条件里「%s」不是其中一项：只有项目、时间、关键词、锚点、kind、主题和要找", at, cutRunes(part, 60)))
		}
		section.Sources.Sessions = sessions
	}
	if len(section.Sources.Docs)+len(section.Sources.Code)+len(section.Sources.Contracts) == 0 && section.Sources.Sessions == nil {
		problems = append(problems, fmt.Sprintf("%s没有写材料来源：机制写「- 文档：」，坑、决策、约定写「- 会话：」", at))
	}
	for _, line := range draft.Stray {
		problems = append(problems, fmt.Sprintf("%s里「%s」不是节的一行：节只有讲什么、文档、代码、契约和会话", at, cutRunes(line, 60)))
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
