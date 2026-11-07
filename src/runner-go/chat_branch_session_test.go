//go:build linux || darwin

package main

import (
	"testing"
	"time"
)

// Through the real supervisor (runInteractiveSession) and a stub control plane: a chat that ends with
// nothing of its own has its branch and checkout dropped once its end is on the record, and a chat
// that made a commit keeps both (wiki contract chat.branch, design §5.2).
func TestAnEndedChatSessionDropsItsEmptyBranch(t *testing.T) {
	for _, tc := range []struct {
		name  string
		work  bool
		keeps bool
	}{
		{name: "nothing of its own", work: false, keeps: false},
		{name: "a commit of its own", work: true, keeps: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			job := runnerStopJob(t, "sess-chat-end")
			_, clone, _ := originAndClone(t)
			chat := pinnedChat(t, clone, job.SessionID)
			job.WorkDir, job.Branch, job.Source, job.WT, job.IsolationStatus = chat.WorkDir, chat.Branch, chat.Source, chat.WT, chat.IsolationStatus
			pin, path, branch := job.Source.BaseSha, job.WT.Path, job.WT.Branch
			if tc.work {
				commitFile(t, path, "fix.txt", "fixed\n", "fix the doc's source")
			}

			api := newRunnerStopControlPlane()
			sup := superviseUntilRunnerStop(t, job, false, api)
			sup.end()
			sup.awaitReturn(t, time.Minute)

			if got := api.finalizeStatuses(); len(got) != 1 || got[0] != stCancelled {
				t.Fatalf("finalize statuses %v, want one cancelled end", got)
			}
			tip := branchAt(clone, branch)
			if tc.keeps {
				if tip == "" || tip == pin || checkoutAbsent(path) {
					t.Fatalf("branch at %q (pin %s), checkout absent %v: a chat with a commit lost its work", tip, pin, checkoutAbsent(path))
				}
				return
			}
			if tip != "" || !checkoutAbsent(path) {
				t.Fatalf("branch at %q, checkout absent %v: the empty chat left them behind", tip, checkoutAbsent(path))
			}
		})
	}
}
