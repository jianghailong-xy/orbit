package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

// When a maintenance run moves the space's cursor, and what a run made while its space is behind leaves for later
// (criterion 3, revision 4: contract `maintenance.job.run.steps` advance, `maintenance.job.run.failure` and
// `maintenance.job.catchUp`). Against the fake door of wiki_maintain_test.go — which keeps the space's cursor, and
// starts a run's first page where it stands, as the server does — the fake model endpoint and Claude Code of
// wiki_verify_test.go, and real git checkouts.

// stepsOf is the routes a run called under the space, in order, each once however many times in a row.
func stepsOf(door *fakeMaintainDoor) []string {
	var steps []string
	for _, call := range door.calls() {
		step := call.method + " " + strings.TrimPrefix(call.path, "/api/runner/wiki/spaces/space-1/")
		if len(steps) == 0 || steps[len(steps)-1] != step {
			steps = append(steps, step)
		}
	}
	return steps
}

// stepAt is where a step first stands in steps, or -1; lastStepAt where it last does.
func stepAt(steps []string, step string) int {
	for i, s := range steps {
		if s == step {
			return i
		}
	}
	return -1
}

func lastStepAt(steps []string, step string) int {
	for i := len(steps) - 1; i >= 0; i-- {
		if steps[i] == step {
			return i
		}
	}
	return -1
}

// extractions is how many dossiers the model was asked to extract from, the retries of an answer aside.
func extractions(vllm *fakeVLLM) int {
	n := 0
	for _, request := range vllm.Requests() {
		if strings.Contains(request.Prompt, "==== CASE FILE ====") && !strings.Contains(request.Prompt, "WERE REJECTED") {
			n++
		}
	}
	return n
}

// watermarkOf is the space's cursor as the door keeps it.
func watermarkOf(door *fakeMaintainDoor) string {
	door.mu.Lock()
	defer door.mu.Unlock()
	return door.watermark
}

// catchUpContext is the run's context as the server answers it for a run its trigger made in catch-up — "active" or
// "paused" — or, for "", one made while the space was not behind.
func catchUpContext(f maintainFixture, mode, expect, catchUp string) func() (int, string) {
	return func() (int, string) {
		status, body := maintainContext(f, mode, 0, expect)()
		var context map[string]interface{}
		_ = json.Unmarshal([]byte(body), &context)
		context["catchUp"] = nil
		if catchUp != "" {
			context["catchUp"] = catchUp
		}
		raw, _ := json.Marshal(context)
		return status, string(raw)
	}
}

// ── The cursor moves once the ops are recorded ──────────────────────────────────────────────────

// As soon as the last batch is recorded the run moves the cursor past the sessions its ops came from — to the last
// page's token, before the anchors and the documents — and ends succeeded at the same token, which moves nothing more.
func TestWikiMaintainCursorAdvanceMovesItAsSoonAsTheOpsAreRecorded(t *testing.T) {
	f := newMaintainFixture(t)
	door := newFakeMaintainDoor(t)
	door.context = maintainContext(f, "tiered", 0, "tok-expect")
	door.pages[""] = maintainPage("tok-1", true, portDossier("session-a"))
	door.pages["tok-1"] = maintainPage("tok-expect", false, werewolfDossier("session-b"))
	door.propose = pendingForVerification
	fakeVerifyClaude(t)
	wikiMaintainSession(t, door.URL, newFakeVLLM(t, extractorAnswers))

	summary, err := runMaintainCLI(t)
	if err != nil {
		t.Fatalf("orbit wiki maintain: %v\n%+v", err, summary)
	}
	steps := stepsOf(door)
	propose, advance := lastStepAt(steps, "POST maintenance/changesets"), stepAt(steps, "POST maintenance/advance")
	if propose < 0 || advance != propose+1 || advance > stepAt(steps, "GET anchors") || advance > stepAt(steps, "GET maintenance/docs") {
		t.Errorf("the run went %v: want the cursor moved right after the last proposal, before the anchors and the documents", steps)
	}
	recorded := 0
	for _, proposal := range door.of(http.MethodPost, "maintenance/changesets") {
		if proposal.body["dryRun"] != true {
			recorded++
		}
	}
	if recorded == 0 || summary.Report.Ops.Recorded == 0 {
		t.Fatalf("the run recorded nothing: %+v", summary.Report.Ops)
	}
	// One move, to the last page's token, as the maintenance session — the position alone, nothing of how the run went.
	moves := door.of(http.MethodPost, "maintenance/advance")
	if len(moves) != 1 || moves[0].body["to"] != "tok-expect" || moves[0].session != "maintenance-session" || len(moves[0].body) != 1 {
		t.Fatalf("the cursor was moved %v, want once to tok-expect as the maintenance session, with the token alone", moves)
	}
	// The end: succeeded, at the token the cursor already stands at.
	end := finished(t, door)
	report, _ := end["report"].(map[string]interface{})
	if end["outcome"] != "succeeded" || end["to"] != "tok-expect" || report["cursorAdvanced"] != true {
		t.Errorf("the run ended %v", end)
	}
	if watermarkOf(door) != "tok-expect" || !summary.Advanced || summary.Cursor != "tok-expect" || !summary.Report.CursorAdvanced {
		t.Errorf("the cursor stands at %q, summary %+v: want it moved to tok-expect", watermarkOf(door), summary)
	}
	if text := describeWikiMaintainSummary(summary); !strings.Contains(text, "The cursor advanced to tok-expect.") {
		t.Errorf("the summary does not say where the cursor went:\n%s", text)
	}
}

// What the breaker held back is the next run's: the cursor moves no further than where the first page it held back
// starts, then and at the end alike.
func TestWikiMaintainCursorAdvanceStopsWhereTheBreakerHeldOpsBack(t *testing.T) {
	f := newMaintainFixture(t)
	door := newFakeMaintainDoor(t)
	door.context = maintainContext(f, "automatic", 229, "tok-expect")
	door.pages[""] = maintainPage("tok-1", true, ruleDossier("session-a"), ruleDossier("session-b"))
	door.pages["tok-1"] = maintainPage("tok-expect", false, ruleDossier("session-c"))
	breaker := &fakeRunBreaker{began: 215, spent: 14}
	door.propose = breaker.propose
	fakeVerifyClaude(t)
	wikiMaintainSession(t, door.URL, newFakeVLLM(t, ruleAnswers))

	summary, err := runMaintainCLI(t)
	if err != nil {
		t.Fatalf("orbit wiki maintain: %v\n%+v", err, summary)
	}
	if summary.Report.Ops.HeldBackByBreaker != 3 {
		t.Fatalf("ops = %+v, want the second page's three held back", summary.Report.Ops)
	}
	moves := door.of(http.MethodPost, "maintenance/advance")
	if len(moves) != 1 || moves[0].body["to"] != "tok-1" {
		t.Errorf("the cursor was moved %v, want once, to where the page the breaker held back starts", moves)
	}
	if end := finished(t, door); end["outcome"] != "succeeded" || end["to"] != "tok-1" || watermarkOf(door) != "tok-1" {
		t.Errorf("the run ended %v with the cursor at %q, want succeeded at tok-1", end, watermarkOf(door))
	}
}

// A step after the proposals that fails — the verification, the anchors — still fails the run, and the documents
// never do; neither moves the cursor back. It stays past the sessions whose ops were recorded, the report and the
// summary say so, and the next run reads none of those sessions again.
func TestWikiMaintainCursorAdvanceIsNotUndoneByAStepThatFailsAfterIt(t *testing.T) {
	for _, c := range []struct {
		name, mode, stoppedAt string
		setUp                 func(door *fakeMaintainDoor)
		model                 func(prompt string) (int, string)
	}{
		{
			name: "the verification", mode: "automatic", stoppedAt: "verify",
			setUp: func(door *fakeMaintainDoor) {
				door.own = []map[string]interface{}{ownItem("op-0", "fixture 不写死端口"), ownItem("op-1", "PORT 在导入时读取")}
			},
			model: func(prompt string) (int, string) {
				if strings.Contains(prompt, "==== CASE FILE ====") {
					return extractorAnswers(prompt)
				}
				return http.StatusUnauthorized, ""
			},
		},
		{
			name: "the anchors", mode: "tiered", stoppedAt: "anchors",
			setUp: func(door *fakeMaintainDoor) {
				door.override["GET anchors"] = func() (int, string) {
					return http.StatusBadRequest, `{"statusCode":400,"message":"repo is not a clone of the space's repository"}`
				}
			},
			model: extractorAnswers,
		},
		{
			name: "the documents", mode: "tiered",
			setUp: func(door *fakeMaintainDoor) {
				door.docs = func() (int, string) {
					return http.StatusBadRequest, `{"statusCode":400,"message":"the plan's documents could not be read"}`
				}
			},
			model: extractorAnswers,
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newMaintainFixture(t)
			door := newFakeMaintainDoor(t)
			door.context = maintainContext(f, c.mode, 0, "tok-expect")
			door.pages[""] = maintainPage("tok-expect", false, portDossier("session-a"))
			door.propose = pendingForVerification
			c.setUp(door)
			vllm := newFakeVLLM(t, c.model)
			fakeVerifyClaude(t)
			wikiMaintainSession(t, door.URL, vllm)

			summary, err := runMaintainCLI(t)
			moves := door.of(http.MethodPost, "maintenance/advance")
			if len(moves) != 1 || moves[0].body["to"] != "tok-expect" {
				t.Fatalf("the cursor was moved %v, want once to tok-expect when the ops were recorded", moves)
			}
			// Nothing moved it back: no other move, no report on the cursor route, and it stands where it was moved to.
			if calls := door.of(http.MethodPost, "cursor"); len(calls) != 0 || watermarkOf(door) != "tok-expect" {
				t.Errorf("the cursor stands at %q, moved by %v: want tok-expect, untouched since", watermarkOf(door), calls)
			}
			steps := stepsOf(door)
			if stepAt(steps, "POST maintenance/advance") > stepAt(steps, "GET anchors") && stepAt(steps, "GET anchors") >= 0 {
				t.Errorf("the run went %v: the cursor moved after the anchors", steps)
			}
			end := finished(t, door)
			report, _ := end["report"].(map[string]interface{})
			if report["cursorAdvanced"] != true || !summary.Report.CursorAdvanced {
				t.Errorf("the report the server kept does not say the cursor moved: %v", report)
			}
			if c.stoppedAt == "" {
				// The documents never fail a run: it succeeds with the step's error in its report.
				if err != nil || summary.Outcome != "succeeded" || end["outcome"] != "succeeded" || end["to"] != "tok-expect" {
					t.Errorf("a run whose documents failed = %v, ended %v: want succeeded at tok-expect", err, end)
				}
				if d := summary.Report.Docs; d == nil || !strings.Contains(d.Error, "could not be read") {
					t.Errorf("the documents' report = %+v, want the step's error kept", d)
				}
			} else {
				// It still ends failed, where it stopped: one more failure in a row, and its check will fail — the cursor stays.
				if err == nil || !strings.Contains(err.Error(), "the cursor had already moved past the sessions whose ops it recorded, "+
					"and the next run does not read them again") {
					t.Errorf("orbit wiki maintain = %v: want the run failed, saying the cursor had moved", err)
				}
				if summary.Outcome != "failed" || end["outcome"] != "failed" || report["stoppedAt"] != c.stoppedAt || end["to"] != nil {
					t.Errorf("the run ended %v (summary %+v): want failed at %s, naming no token", end, summary, c.stoppedAt)
				}
				if text := describeWikiMaintainSummary(summary); !strings.Contains(text,
					"The cursor had moved past the sessions whose ops the run recorded before it failed: the next run does not read them again.") {
					t.Errorf("the summary does not say where the cursor stands:\n%s", text)
				}
			}

			// The next run starts where the cursor stands: it reads none of those sessions again.
			delete(door.override, "GET anchors")
			door.docs = nil
			door.context = maintainContext(f, c.mode, 0, "tok-next")
			door.pages["tok-expect"] = maintainPage("tok-next", false)
			read := extractions(vllm)
			next, err := runMaintainCLI(t)
			if err != nil {
				t.Fatalf("the next run: %v\n%+v", err, next)
			}
			if extractions(vllm) != read || next.Report.Sessions != 0 || next.Report.Ops.Proposed != 0 {
				t.Errorf("the next run read %d sessions, extracted %d more and proposed %d ops: want none of the last run's again",
					next.Report.Sessions, extractions(vllm)-read, next.Report.Ops.Proposed)
			}
		})
	}
}

// Before the ops are recorded nothing moves the cursor: a model that refuses the token while the run extracts, a
// server that refuses an op the dry run passed, and a run the turn limit cut short before it recorded anything —
// what the runner reports for that carries no token.
func TestWikiMaintainCursorAdvanceNeverMovesItBeforeTheOpsAreRecorded(t *testing.T) {
	setUp := func(t *testing.T, model func(prompt string) (int, string)) (*fakeMaintainDoor, *fakeVLLM) {
		f := newMaintainFixture(t)
		door := newFakeMaintainDoor(t)
		door.context = maintainContext(f, "tiered", 0, "tok-expect")
		door.pages[""] = maintainPage("tok-expect", false, portDossier("session-a"))
		door.propose = pendingForVerification
		vllm := newFakeVLLM(t, model)
		fakeVerifyClaude(t)
		wikiMaintainSession(t, door.URL, vllm)
		return door, vllm
	}
	unmoved := func(t *testing.T, door *fakeMaintainDoor, err error, stoppedAt string) {
		t.Helper()
		if moves := door.of(http.MethodPost, "maintenance/advance"); len(moves) != 0 || watermarkOf(door) != "" {
			t.Errorf("the cursor was moved %v to %q before the ops were recorded", moves, watermarkOf(door))
		}
		if err == nil || !strings.Contains(err.Error(), "the cursor did not move") {
			t.Errorf("orbit wiki maintain = %v: want the run failed with the cursor where it was", err)
		}
		end := finished(t, door)
		report, _ := end["report"].(map[string]interface{})
		if end["outcome"] != "failed" || report["stoppedAt"] != stoppedAt || report["cursorAdvanced"] != nil {
			t.Errorf("the run ended %v: want failed at %s, the cursor not moved", end, stoppedAt)
		}
	}

	t.Run("the model refuses the token while the run extracts", func(t *testing.T) {
		door, _ := setUp(t, func(string) (int, string) { return http.StatusUnauthorized, "" })
		_, err := runMaintainCLI(t)
		unmoved(t, door, err, "extract")
	})

	t.Run("the server refuses an op the dry run passed", func(t *testing.T) {
		door, _ := setUp(t, extractorAnswers)
		door.propose = func(ops []interface{}, dryRun bool) (int, string) {
			if dryRun {
				return pendingForVerification(ops, dryRun)
			}
			raw, _ := json.Marshal(map[string]interface{}{"changesetId": "cs-1", "ops": []interface{}{
				map[string]interface{}{"seq": 0, "status": "applied", "opId": "op-0", "entryId": "e-0"},
				map[string]interface{}{"seq": 1, "status": "refused", "reasons": []interface{}{map[string]interface{}{"code": "WIKI_SOURCE_UNRESOLVED", "message": "no such record"}}},
			}})
			return http.StatusOK, string(raw)
		}
		_, err := runMaintainCLI(t)
		unmoved(t, door, err, "propose")
	})

	t.Run("the turn limit cuts the run short before it recorded anything", func(t *testing.T) {
		release := make(chan struct{})
		door, vllm := setUp(t, func(string) (int, string) {
			<-release
			return http.StatusUnauthorized, ""
		})
		var out strings.Builder
		ended := make(chan error, 1)
		go func() {
			ended <- cmdWikiCLI([]string{"maintain", "--space", "space-1", "--json"}, strings.NewReader(""), &out)
		}()
		waitUntil(t, func() bool { return len(vllm.Requests()) > 0 }, "the run never asked the model")
		// The CLI reached its turn limit while the run was extracting: the runner says so on the cursor, with no token.
		reportWikiMaintenanceTruncated(NewTransport(door.URL, "runner-token"),
			&ClaimedSession{SessionID: "maintenance-session", WikiMaintenance: &WikiMaintenanceRun{SpaceID: "space-1", MaxTurns: 120}})
		cut := door.of(http.MethodPost, "cursor")
		if len(cut) != 1 || cut[0].body["outcome"] != "truncated" || cut[0].body["to"] != nil {
			t.Fatalf("the cut-short run was reported %v, want outcome truncated and no token", cut)
		}
		if why, _ := cut[0].body["error"].(string); !strings.Contains(why, "no further than past the ops it had recorded") {
			t.Errorf("the report says %q", why)
		}
		if moves := door.of(http.MethodPost, "maintenance/advance"); len(moves) != 0 || watermarkOf(door) != "" {
			t.Errorf("the cursor was moved %v to %q while the run had recorded nothing", moves, watermarkOf(door))
		}
		close(release)
		err := <-ended
		var summary wikiMaintainSummary
		if jsonErr := json.Unmarshal([]byte(out.String()), &summary); jsonErr != nil {
			t.Fatalf("--json printed %q: %v", out.String(), jsonErr)
		}
		unmoved(t, door, err, "extract")
		if summary.Report.Ops.Recorded != 0 {
			t.Errorf("ops = %+v, want nothing recorded", summary.Report.Ops)
		}
	})
}

// A server that predates the route: the run goes on, and the cursor moves at its end, as it always did.
func TestWikiMaintainCursorAdvanceWaitsForTheEndOnAServerWithoutTheRoute(t *testing.T) {
	f := newMaintainFixture(t)
	door := newFakeMaintainDoor(t)
	door.context = maintainContext(f, "tiered", 0, "tok-expect")
	door.pages[""] = maintainPage("tok-expect", false, portDossier("session-a"))
	door.propose = pendingForVerification
	door.advanceMissing = true
	fakeVerifyClaude(t)
	wikiMaintainSession(t, door.URL, newFakeVLLM(t, extractorAnswers))

	summary, err := runMaintainCLI(t)
	if err != nil || summary.Outcome != "succeeded" || !summary.Advanced {
		t.Fatalf("orbit wiki maintain on an older server = %v, %+v: want it to succeed and advance at its end", err, summary)
	}
	if len(door.of(http.MethodPost, "maintenance/advance")) != 1 || summary.Report.CursorAdvanced {
		t.Errorf("report %+v: want the move asked once, and not reported as made", summary.Report)
	}
	if end := finished(t, door); end["outcome"] != "succeeded" || end["to"] != "tok-expect" || watermarkOf(door) != "tok-expect" {
		t.Errorf("the run ended %v with the cursor at %q", end, watermarkOf(door))
	}
}

// ── A space that is behind writes no document ───────────────────────────────────────────────────

// A run made while the space was behind — catching up, or its catch-up paused — skips the documents whole: it asks
// nothing of them, writes no section and proposes no change to the plan, though origin/main moved and an entry has no
// place. It still proposes its entries, moves the cursor and succeeds.
func TestWikiMaintainCatchUpSkipsTheDocumentsAndThePlanProposal(t *testing.T) {
	for _, state := range []string{"active", "paused"} {
		t.Run(state, func(t *testing.T) {
			f := docsRepo(t)
			written := f.first
			f.push(t, "the design moves on, and a design document no section cites", func() {
				f.write(t, map[string]string{"docs/design.md": docsDesignAfter, "docs/new-design.md": docsNewDesign})
			})
			door := newFakeMaintainDoor(t)
			door.context = catchUpContext(f.maintainFixture, "tiered", "tok-expect", state)
			door.pages[""] = maintainPage("tok-expect", false, portDossier("session-a"))
			door.propose = pendingForVerification
			door.docs = docsAffectedAnswer(written, map[string]interface{}{"id": "e-9", "kind": "concept", "title": "Codex 登录由服务器保管",
				"summary": "登录只在服务器上。", "topics": []string{}, "anchorPaths": []string{}, "changedAt": "2026-09-30T01:00:00.000Z"})
			door.plan = docsPlanFor()
			door.docsState = docsWrittenAt(written, "s1", "s2", "s3", "s4", "s5")
			door.material = map[string]string{"runner#s5": docsMaterialS5}
			model := &docsRunModel{}
			vllm := newFakeVLLM(t, func(prompt string) (int, string) {
				if strings.Contains(prompt, "==== CASE FILE ====") {
					return extractorAnswers(prompt)
				}
				return model.answer(prompt)
			})
			fakeVerifyClaude(t)
			wikiMaintainSession(t, door.URL, vllm)

			summary, err := runMaintainCLI(t)
			if err != nil || summary.Outcome != "succeeded" {
				t.Fatalf("a run catching up: %v\n%+v", err, summary)
			}
			if summary.Report.Ops.Recorded == 0 || watermarkOf(door) != "tok-expect" {
				t.Errorf("ops %+v, cursor %q: want the entries proposed and the cursor moved past them", summary.Report.Ops, watermarkOf(door))
			}
			for _, call := range door.calls() {
				route := strings.TrimPrefix(call.path, "/api/runner/wiki/spaces/space-1/")
				if route == "maintenance/docs" || route == "plan" || route == "docs" || strings.HasPrefix(route, "docs/") ||
					route == "maintenance/docs/withdrawals" || route == "plan/proposals" {
					t.Errorf("%s %s was called while the space catches up", call.method, route)
				}
			}
			for _, prompt := range model.Prompts() {
				t.Errorf("the model was asked about the documents while the space catches up: %.120s", prompt)
			}
			d := summary.Report.Docs
			if d == nil || d.Skipped != "catching_up" || d.PlanVersion != nil || d.Proposal != nil || d.Tokens.Calls != 0 {
				t.Errorf("the documents' report = %+v, want skipped catching_up, nothing written or proposed", d)
			}
			report, _ := finished(t, door)["report"].(map[string]interface{})
			if docs, _ := report["docs"].(map[string]interface{}); docs["skipped"] != "catching_up" {
				t.Errorf("the report the server kept says %v", report["docs"])
			}
			if text := describeWikiMaintainSummary(summary); !strings.Contains(text, "- documents: the space is catching up — none was written "+
				"and no change to the plan proposed; the first run after it has caught up writes what changed meanwhile") {
				t.Errorf("the summary does not say the documents wait:\n%s", text)
			}
		})
	}
}

// Two runs while the space is behind, origin/main moving under each — the design's section 2 changes, then a cited
// file is deleted — and entries written by both: no document is touched. The first run once the space has caught up
// writes, at origin/main as it now stands, every section that changed meanwhile — s2 for its design section, s3 for
// its file gone, s5 for the entries — in that one run, and leaves s1 and s4, whose material did not change, as they are.
func TestWikiMaintainCatchUpRewritesWhatChangedMeanwhileOnceCaughtUp(t *testing.T) {
	f := docsRepo(t)
	written := f.first
	door := newFakeMaintainDoor(t)
	door.propose = pendingForVerification
	door.plan = docsPlanFor()
	door.docsState = docsWrittenAt(written, "s1", "s2", "s3", "s4", "s5")
	door.material = map[string]string{"runner#s5": docsMaterialS5}
	var withdrawals []map[string]interface{}
	door.withdraw = func(body map[string]interface{}) (int, string) {
		withdrawals = append(withdrawals, body)
		return http.StatusOK, `{"spaceId":"space-1","withdrawn":1,"sections":[{"doc":"runner","key":"s3"}]}`
	}
	// What the server says to write again, once it is asked: s5, which the entries both runs wrote fit — counted from
	// the section's own generation, so every entry since is there, whichever run wrote it.
	door.docs = func() (int, string) {
		raw, _ := json.Marshal(map[string]interface{}{
			"spaceId": "space-1",
			"plan":    map[string]interface{}{"version": 4, "confirmedAt": "2026-09-29T09:00:00.000Z", "repoSha": written, "draftedAt": "2026-09-28T09:00:00.000Z"},
			"build":   nil,
			"sections": []interface{}{map[string]interface{}{"doc": "runner", "key": "s5", "repoSha": written, "generatedAt": "2026-09-29T10:00:00.000Z",
				"stale": false, "entryIds": []string{"e-1", "e-2"}}},
			"unplaced": []interface{}{}, "unplacedMore": 0,
			"proposed": map[string]interface{}{"entryIds": []string{}, "commits": []string{}, "paths": []string{}},
		})
		return http.StatusOK, string(raw)
	}
	model := &docsRunModel{}
	vllm := newFakeVLLM(t, func(prompt string) (int, string) {
		if strings.Contains(prompt, "==== CASE FILE ====") {
			return extractorAnswers(prompt)
		}
		return model.answer(prompt)
	})
	fakeVerifyClaude(t)
	wikiMaintainSession(t, door.URL, vllm)

	door.pages[""] = maintainPage("tok-a", false, portDossier("session-a"))
	door.pages["tok-a"] = maintainPage("tok-b", false, portDossier("session-b"))
	for i, run := range []struct {
		expect string
		change map[string]string
	}{
		{"tok-a", map[string]string{"docs/design.md": docsDesignAfter}},
		{"tok-b", map[string]string{"docs/old.md": ""}},
	} {
		f.push(t, fmt.Sprintf("origin/main moves on under catch-up run %d", i+1), func() { f.write(t, run.change) })
		door.context = catchUpContext(f.maintainFixture, "tiered", run.expect, "active")
		summary, err := runMaintainCLI(t)
		if err != nil || summary.Outcome != "succeeded" || summary.Report.Ops.Recorded == 0 {
			t.Fatalf("catch-up run %d: %v\n%+v", i+1, err, summary)
		}
		if d := summary.Report.Docs; d == nil || d.Skipped != "catching_up" {
			t.Errorf("catch-up run %d's documents = %+v, want them left for later", i+1, d)
		}
	}
	if asked := door.of(http.MethodGet, "maintenance/docs"); len(asked) != 0 || len(docsWrites(t, door)) != 0 || len(withdrawals) != 0 {
		t.Fatalf("the runs behind asked %d times what to write and wrote %v", len(asked), keysOfWrites(docsWrites(t, door)))
	}

	// Caught up: the next run was made with the space behind no more.
	head := mustGit(t, f.seed, "rev-parse", "HEAD")
	door.context = catchUpContext(f.maintainFixture, "tiered", "tok-c", "")
	door.pages["tok-b"] = maintainPage("tok-c", false)
	summary, err := runMaintainCLI(t)
	if err != nil || summary.Outcome != "succeeded" {
		t.Fatalf("the run after catching up: %v\n%+v", err, summary)
	}
	d := summary.Report.Docs
	if d == nil || d.Skipped != "" || d.PlanVersion == nil || d.RepoSha != head {
		t.Fatalf("the documents' report = %+v, want plan version 4 written at origin/main %s", d, head)
	}
	if d.Affected.ByRepo != 2 || d.Affected.ByEntries != 1 || d.Affected.Total != 3 {
		t.Errorf("affected = %+v, want s2 and s3 by the repository and s5 by the entries", d.Affected)
	}
	writes := docsWrites(t, door)
	if got := keysOfWrites(writes); !reflect.DeepEqual(got, []string{"s2", "s3", "s5"}) {
		t.Errorf("the run wrote %v, want s2, s3 and s5 — not s1 or s4, whose material did not change", got)
	}
	for key, section := range writes {
		if section["_repoSha"] != head {
			t.Errorf("%s was written at %v, want origin/main as it stands, %s", key, section["_repoSha"], head)
		}
	}
	if d.Sections.Written != 3 || d.Sections.Failed != 0 {
		t.Errorf("sections = %+v, want the three written", d.Sections)
	}
	gone, _ := json.Marshal(withdrawals)
	if len(withdrawals) != 1 || !strings.Contains(string(gone), `{"change":"deleted","path":"docs/old.md"}`) || withdrawals[0]["repoSha"] != head {
		t.Errorf("withdrawals = %s, want docs/old.md once, at %s", gone, head)
	}
	for _, prompt := range model.Prompts() {
		taken := strings.Contains(prompt, "# 任务：写文档") || strings.Contains(prompt, "做「归并」")
		if taken && (strings.Contains(prompt, "「传输」（") || strings.Contains(prompt, "「派发」（")) {
			t.Errorf("a section whose material did not change was taken up: %.120s", prompt)
		}
	}
}
