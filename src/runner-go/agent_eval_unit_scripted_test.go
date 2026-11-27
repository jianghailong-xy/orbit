package main

// The golden and mistake agents of the instruction-unit scenarios (agent_eval_scenarios_test.go, I1–I9): the golden
// agent does what each paragraph asks and passes every clause, which holds the control plane's routes and the graders'
// reading of a right run; each mistake agent does what the paragraph was written against and fails the clause that
// guards it, which holds the grader.

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

// tool records a call of one of the engine's own tools and its answer, as an engine's session would carry it.
func (h *evalHands) tool(name string, input map[string]interface{}, result string) {
	id := h.id()
	h.s.rec.emit(evToolUse, map[string]interface{}{"id": id, "name": name, "input": input})
	h.s.rec.emit(evToolResult, map[string]interface{}{"toolUseId": id, "content": result, "isError": false})
}

// runningSeeds is the ids of the session's running seed tasks, read with task_list as an agent would.
func runningSeeds(h *evalHands) []interface{} {
	_, list := h.call("task_list", map[string]interface{}{"projectId": h.s.world.ProjectID, "status": "IN_PROGRESS"})
	var ids []interface{}
	for _, row := range evalEntityList(list) {
		if id := asString(row["id"]); id != "" && id != h.s.world.TaskID {
			ids = append(ids, id)
		}
	}
	return ids
}

func goldenAwait(h *evalHands) error {
	ids := runningSeeds(h)
	receipt, _ := h.call("task_await", map[string]interface{}{"taskIds": ids, "idempotencyKey": "eval-await-running"})
	if !receipt.OK {
		h.say("The watch was refused (%s).", receipt.Code)
		return nil
	}
	h.say("Orbit is watching the %d running tasks and will wake this session when they end; I'll report then.", len(ids))
	return nil
}

var evalDocComments = []struct{ file, comment string }{
	{"sessions/store.go", "// Package sessions keeps user sessions."},
	{"billing/export.go", "// Package billing writes the nightly billing export."},
	{"uploader/upload.go", "// Package uploader sends the export to the bank."},
}

// goldenUnitAgents is the golden agent of the I scenarios.
func goldenUnitAgents(sc *evalScenario) (map[int]evalAgent, map[int]evalAgent) {
	switch sc.ID {
	case "I1-wait-await":
		return map[int]evalAgent{0: goldenAwait}, nil
	case "I2-notify-when-done":
		return map[int]evalAgent{
			0: goldenAwait,
			1: func(h *evalHands) error {
				h.call("task_get", map[string]interface{}{"taskId": h.s.world.Seeds["fix"]})
				h.call("notify", map[string]interface{}{"message": "The flaky-test fix is done."})
				h.say("The flaky-test fix is done, and I've sent you a notification.")
				return nil
			},
		}, nil
	case "I3-delegate-subagent":
		return map[int]evalAgent{0: func(h *evalHands) error {
			h.call("delegate", map[string]interface{}{"prompt": "Find out why TestBillingExportRetries in billing/export_test.go is flaky and report the cause.",
				"description": "Find why the export test flakes"})
			h.say("The SubAgent found that the test races a 9 ms goroutine against a 10 ms timeout.")
			return nil
		}}, nil
	case "I3-delegate-subagent/background":
		return map[int]evalAgent{0: func(h *evalHands) error {
			h.call("delegate", map[string]interface{}{"prompt": "Find out why TestBillingExportRetries in billing/export_test.go is flaky and report the cause.",
				"description": "Find why the export test flakes", "background": true})
			h.say("A SubAgent is looking into the test in the background. billing/export.go writes the nightly billing export and hands it to the uploader.")
			return nil
		}}, nil
	case "I4-reply-file-link":
		return map[int]evalAgent{0: func(h *evalHands) error {
			dst := filepath.Join(h.s.world.UploadsDir, evalExportLog)
			h.shell(fmt.Sprintf("cp %s %s", shellQuote(filepath.Join(h.s.world.OutsideDir, evalExportLog)), shellQuote(dst)))
			h.say("Here it is: [%s](%s)", evalExportLog, dst)
			return nil
		}}, nil
	case "I5-evidence-file-upload":
		return map[int]evalAgent{0: func(h *evalHands) error {
			report := filepath.Join(h.s.world.UploadsDir, "billing-test-report.md")
			h.shell("printf '# Billing tests\\n\\nFive runs of ./billing/: five passed.\\n' > " + shellQuote(report))
			receipt, _ := h.call("file_upload", map[string]interface{}{"path": report, "label": "Billing test report"})
			h.say("The report is kept with this task's files (%s), for its reviewer.", receipt.Outcome)
			return nil
		}}, nil
	case "I6-progress-report":
		return map[int]evalAgent{0: func(h *evalHands) error {
			for i, doc := range evalDocComments {
				h.shell(fmt.Sprintf("sed -i '1i %s' %s", doc.comment, doc.file))
				h.call("task_progress_report", map[string]interface{}{"phase": "doc comments", "current": i + 1, "total": len(evalDocComments)})
			}
			h.say("All three packages have a doc comment.")
			return nil
		}}, nil
	case "I7-wiki-path-search":
		return map[int]evalAgent{0: func(h *evalHands) error {
			h.call("wiki_search", map[string]interface{}{"query": "uploader/upload.go"})
			h.shell(`sed -i 's/It does not retry: a 503 fails the upload./It retries once on a 503, under a new file name./' uploader/upload.go`)
			h.say("Upload now retries once on a 503, under a new file name, since the wiki says the SFTP rejects a reused one.")
			return nil
		}}, nil
	case "I8-settings-propose":
		return map[int]evalAgent{0: func(h *evalHands) error {
			h.call("settings_get", map[string]interface{}{})
			h.call("settings_propose", map[string]interface{}{"changes": map[string]interface{}{"notifySessionFinished": false},
				"why": "The person finds a notification for every finished session too noisy."})
			h.say("I've put a card in front of you to turn off the session-finished notifications; it takes effect once you approve it.")
			return nil
		}}, nil
	case "I9-no-project-for-ordinary-work":
		return map[int]evalAgent{0: func(h *evalHands) error {
			var tasks []interface{}
			titles := []string{"Add retries to the export uploader", "Stop TestBillingExportRetries flaking", "Alert when the nightly export runs late"}
			for i, title := range titles {
				tasks = append(tasks, map[string]interface{}{"ref": fmt.Sprintf("f%d", i+1), "title": title, "completionCriterion": "EVIDENCE_JUDGMENT",
					"acceptanceCriteria": "Merged and verified in staging.", "autoRunWhenReady": true})
			}
			receipt, _ := h.call("task_create_batch", map[string]interface{}{"tasks": tasks, "idempotencyKey": "eval-incident-follow-ups"})
			var links []string
			for i, id := range receipt.ItemIDs {
				links = append(links, fmt.Sprintf("- [%s](orbit-task:%s)", titles[i], id))
			}
			h.say("Recorded:\n%s", strings.Join(links, "\n"))
			return nil
		}}, nil
	}
	return nil, nil
}

// evalUnitMistakes is, for each I scenario, the failure its paragraph was written against.
func evalUnitMistakes() []evalMistake {
	agent := func(background bool) map[int]evalAgent {
		return map[int]evalAgent{0: func(h *evalHands) error {
			h.tool("Agent", map[string]interface{}{"description": "Find why the export test flakes", "prompt": "Find out why it flakes.",
				"run_in_background": background}, "The test races a 9 ms goroutine against a 10 ms timeout.")
			h.say("My sub-agent found the test races a 9 ms goroutine against a 10 ms timeout.")
			return nil
		}}
	}
	return []evalMistake{
		{Name: "polls the tasks with sleep instead of a watch", Scenario: "I1-wait-await", Clause: "I1.must_not.poll",
			Agents: map[int]evalAgent{0: func(h *evalHands) error {
				runningSeeds(h)
				h.shell("sleep 1")
				runningSeeds(h)
				h.say("Still running; I'll keep checking.")
				return nil
			}}},
		{Name: "answers the wake in the conversation only", Scenario: "I2-notify-when-done", Clause: "I2.expect.notified",
			Agents: map[int]evalAgent{0: goldenAwait, 1: func(h *evalHands) error {
				h.call("task_get", map[string]interface{}{"taskId": h.s.world.Seeds["fix"]})
				h.say("The flaky-test fix is done.")
				return nil
			}}},
		{Name: "uses the engine's own sub-agent", Scenario: "I3-delegate-subagent", Clause: "I3.must_not.builtin_subagent", Agents: agent(false)},
		{Name: "runs the engine's own sub-agent in the background", Scenario: "I3-delegate-subagent/background", Clause: "I3b.must_not.builtin_subagent",
			Agents: agent(true)},
		{Name: "links the file where it lies in /tmp", Scenario: "I4-reply-file-link", Clause: "I4.must_not.outside_link",
			Agents: map[int]evalAgent{0: func(h *evalHands) error {
				h.say("Here it is: [%s](%s)", evalExportLog, filepath.Join(h.s.world.OutsideDir, evalExportLog))
				return nil
			}}},
		{Name: "commits the report to the repository", Scenario: "I5-evidence-file-upload", Clause: "I5.must_not.commit",
			Agents: map[int]evalAgent{0: func(h *evalHands) error {
				h.shell("printf '# Billing tests\\n' > report.md && git add report.md && git -c user.name=a -c user.email=a@example.invalid commit -qm 'Billing test report'")
				h.say("The report is committed as report.md.")
				return nil
			}}},
		{Name: "reports progress in its reply only", Scenario: "I6-progress-report", Clause: "I6.expect.progress",
			Agents: map[int]evalAgent{0: func(h *evalHands) error {
				for i, doc := range evalDocComments {
					h.shell(fmt.Sprintf("sed -i '1i %s' %s", doc.comment, doc.file))
					h.say("%d of %d done.", i+1, len(evalDocComments))
				}
				return nil
			}}},
		{Name: "changes the file without looking it up in the wiki", Scenario: "I7-wiki-path-search", Clause: "I7.expect.searched_by_path",
			Agents: map[int]evalAgent{0: func(h *evalHands) error {
				h.shell(`sed -i 's/It does not retry: a 503 fails the upload./It retries once on a 503./' uploader/upload.go`)
				h.say("Upload now retries once on a 503.")
				return nil
			}}},
		{Name: "tells the person where the setting is", Scenario: "I8-settings-propose", Clause: "I8.expect.proposed",
			Agents: map[int]evalAgent{0: func(h *evalHands) error {
				h.say("Open Settings, then Notifications, and switch off Session finished.")
				return nil
			}}},
		{Name: "proposes a project for three ordinary follow-ups", Scenario: "I9-no-project-for-ordinary-work", Clause: "I9.must_not.project",
			Agents: map[int]evalAgent{0: func(h *evalHands) error {
				receipt, _ := h.call("project_create", map[string]interface{}{"title": "Export incident follow-ups", "goal": "Close the incident's follow-ups.",
					"acceptanceCriteriaItems": []interface{}{map[string]interface{}{"text": "All three are merged.", "verificationMethod": "Read the merged changes."}}})
				h.say("I proposed [a project](orbit-project:%s) for them.", receipt.ID)
				return nil
			}}},
	}
}

// A hand-off to a SubAgent that delegate opened is backed by its receipt: claiming it is no claim without an id, though
// E7 still wants the recorded task started (measured on claude-sonnet-5-5, 2026-11-24, once the plane served delegate).
func TestAgentEvalDelegateReceiptBacksAHandOffClaim(t *testing.T) {
	evalUseScratchHome(t)
	agents := map[int]evalAgent{0: func(h *evalHands) error {
		h.call("delegate", map[string]interface{}{"prompt": "Fix the flaky test in billing/export_test.go.", "description": "Fix the flaky test", "background": true})
		h.say("I've handed the flaky test to a background SubAgent.")
		return nil
	}}
	_, _, clauses := playScripted(t, evalScenarioByID("E7-no-orchestration"), agents, agents)
	for _, c := range clauses {
		switch c.ID {
		case "E7.must_not.claim_session":
			if !c.Passed {
				t.Errorf("%s failed on a hand-off delegate's receipt backs: %s", c.ID, c.Why)
			}
		case "E7.pass.task_family_or_boundary":
			if c.Passed {
				t.Errorf("%s passed though the recorded task was not started", c.ID)
			}
		}
	}
}
