package main

import "testing"

// Direct delivery leaves no remote task ref. Only the frozen task commit on the freshly fetched
// target proves delivery; a local target, an absent identity, or an empty source proves nothing.
func TestPromotionDirectDelivery(t *testing.T) {
	for _, scenario := range []string{"delivered", "unpublished", "missing-identity", "empty"} {
		t.Run(scenario, func(t *testing.T) {
			r := newIntegrationRepo(t)
			base := r.rev("main")
			r.checkoutNew("task/direct", "main")
			r.write("delivery.txt", "the task's delivery\n")
			source := r.commit("task delivery")
			r.checkout("main")
			mustRun(t, r.work, "git", "merge", "--ff-only", source)
			if scenario != "unpublished" {
				r.push("main")
			}
			cmd := r.promotionCommand("CHECK_PROMOTION", "task/direct", "TASK_BRANCH")
			cmd.SourceSha = source
			cmd.SessionBaseSha = base
			if scenario == "missing-identity" {
				cmd.SourceSha = ""
			}
			if scenario == "empty" {
				r.push("task/direct")
				cmd.SourceSha = base
			}
			for attempt := 0; attempt < 2; attempt++ {
				result := runIntegrationJob(cmd, silent)
				if scenario == "delivered" {
					if result.State != "ALREADY_LANDED" || result.SourceSha != source || result.TargetShaBefore != source {
						t.Fatalf("attempt %d: want verified delivery, got %+v", attempt, result)
					}
				} else if result.State == "ALREADY_LANDED" || result.State == "LANDED" {
					t.Fatalf("%s must not produce a receipt: %+v", scenario, result)
				}
			}
		})
	}
}
