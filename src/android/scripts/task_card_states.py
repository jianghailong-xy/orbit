"""The task card's four states (docs/task-run-sidebar-design.md, board docs/mocks/task-run-sidebar/02-real.png), as GET /tasks/:id
and the reads beside it answer them, for the screenshot fixtures of both phones: the Android emulator's composer-fixture.py and the
iOS Simulator probe's stub.py import this one module, so the two platforms photograph the same data. All data is made up; the
shapes are the apiserver's (TasksService.findOne with migration 1672's acceptanceRounds, GET /sessions/:id, /tasks/:id/evidence,
/tasks/:id/owner-confirmation).

    scenarios(session_id, workspace_id, now) -> {state: {"taskId", "task", "session", "evidence", "owner"}}

`session` is what GET /sessions/<session_id> adds to the conversation the card is opened over (its task and its branch)."""
from datetime import datetime, timedelta, timezone

STATES = ("failed", "running", "needs-you", "done")


def _iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def _commit(sha, subject, at):
    return {"sha": sha, "subject": subject, "body": None, "committedAt": at, "savedBy": None, "files": [], "filesTruncated": False}


def scenarios(session_id, workspace_id, now=None):
    now = now or datetime.now(timezone.utc)
    ago = lambda minutes: _iso(now - timedelta(minutes=minutes))
    agent = {"id": workspace_id, "name": "orbit-ws01"}
    creator = {"id": "task-card-creator", "title": "Polish the header share button", "status": "SUCCEEDED"}

    def run(**fields):
        return {"title": "Task run", "agent": {"name": "orbit-ws01"}, "effort": "medium", "endReason": None, "archivedAt": None,
                "deletedAt": None, "lastTurnOutcome": None, "acceptanceRounds": [], "error": None, **fields}

    def task(task_id, title, status, sessions, **fields):
        return {"id": task_id, "title": title, "status": status, "assignee": agent, "assigneeId": workspace_id,
                "projectId": None, "project": None, "listId": None, "createdAt": ago(26 * 60), "updatedAt": ago(1),
                "creatorSession": creator, "comments": [], "attachments": [], "dependsOn": [], "dependedOnBy": [],
                "dependencyState": "READY", "model": None, "provider": None, "engine": None, "sessions": sessions,
                "integration": {"state": "NOT_APPLICABLE", "mainBranch": "main"}, "progress": {"revision": 0}, **fields}

    failed_id = "task-card-failed"
    failed = task(failed_id, "Fix the date-dependent failures in the web test suite and the duplicate heading in the config guide",
        "FAILED",
        [run(id=session_id, status="FAILED", runStatus="FAILED", runState="FAILED", createdAt=ago(70), model="claude-sonnet-5-5",
             costUsd=1.32, lastTurnOutcome="ANSWERED", error="acceptance command exited 1; expected 0",
             acceptanceRounds=[{"id": "round-1", "turnId": "turn-acceptance-1", "exitCode": 1, "expectedExitCode": 0,
                                "branchSha": "432e94c8d1f0", "finishedAt": ago(12),
                                "outputTail": "FAIL src/web/src/lib/time.test.ts > formats a date across midnight\n1 failed, 9788 passed"}]),
         run(id="task-card-run-1", status="FAILED", runStatus="FAILED", runState="FAILED", createdAt=ago(25 * 60),
             model="claude-sonnet-5-5", costUsd=0.61, lastTurnOutcome="FAILED")],
        completionCriterion="EXECUTABLE", acceptanceCommand="npm run docs:check && cd src/web && npx vitest run",
        acceptanceExpectedExitCode=0,
        acceptanceCriteria="- `npm run docs:check` passes\n- Full web suite, 0 failed\n- Fix the clock dependence, don't weaken tests",
        description="main is red in two places, found while landing an unrelated header change. Both also fail on main's own code.",
        comments=[{"id": "note-1", "authorType": "AGENT", "authorId": workspace_id, "authorName": "orbit-ws01", "createdAt": ago(10),
                   "body": "Machine load, not the code. The run's own check exited 0 at 06:48; Orbit's acceptance ran the same "
                           "command at 06:50 and exited 1.\n\nThe failing test reads the wall clock."}])

    running_id = "task-card-running"
    running = task(running_id, "Add retry to the upload step", "IN_PROGRESS",
        [run(id=session_id, status="RUNNING", runStatus="RUNNING", runState="RUNNING", phase="RUNNING", activity="TURN",
             createdAt=ago(7), model="claude-opus-5-5", costUsd=0.84)],
        completionCriterion="EXECUTABLE", acceptanceCommand="npm test", acceptanceExpectedExitCode=0,
        acceptanceCriteria="- Upload retries 3× on 5xx", description="Uploads fail on the first 5xx. Retry three times with backoff.",
        progress={"revision": 3, "phase": "Retry with backoff in upload.ts", "current": 3, "total": 5,
                  "message": "Read the design; specs and evidence next.", "lastProgressAt": ago(2)})

    needs_id = "task-card-needs-you"
    needs = task(needs_id, "Add retry to the upload step", "IN_PROGRESS",
        [run(id=session_id, status="AWAITING_INPUT", runStatus="AWAITING_INPUT", runState="AWAITING_INPUT", phase="WAITING",
             waitingOn="PERSON", lastTurnOutcome="ANSWERED", workFinished=True, createdAt=ago(46), model="claude-sonnet-5-5",
             costUsd=3.12)],
        completionCriterion="OWNER_CONFIRMED",
        acceptanceCriteria="- Upload retries 3× on 5xx\n- `npm test` exits 0",
        description="Uploads fail on the first 5xx. Retry three times with backoff.")
    needs_evidence = [{"revision": "1", "submittedAt": ago(3), "decision": None,
                       "evidence": {"claim": "Uploads retry three times on a 5xx, with backoff.", "gaps": [],
                                    "checks": [{"kind": "COMMIT", "ref": "b4c2d3e4f5a6", "succeeded": True},
                                               {"kind": "TOOL_CALL", "ref": "bgj_fixture", "command": "npm test", "succeeded": True}]}}]
    needs_owner = {"taskId": needs_id, "title": needs["title"], "status": "IN_PROGRESS", "projectId": None,
                   "completionCriterion": "OWNER_CONFIRMED", "acceptanceCriteria": needs["acceptanceCriteria"],
                   "waiting": {"requestId": "owner-request-1", "sessionId": session_id, "requestedAt": ago(3), "report": None,
                               "review": None},
                   "decisions": [], "ifConfirmed": None, "reviewerReturns": []}

    done_id = "task-card-done"
    done = task(done_id, "Add retry to the upload step", "DONE",
        [run(id=session_id, status="SUCCEEDED", runStatus="SUCCEEDED", runState="SUCCEEDED", phase="ENDED", lastTurnOutcome="ANSWERED",
             workFinished=True, createdAt=ago(26 * 60), model="claude-sonnet-5-5", costUsd=3.12)],
        completionCriterion="EVIDENCE_JUDGMENT",
        acceptanceCriteria="- Upload retries 3× on 5xx\n- `npm test` exits 0",
        description="Uploads fail on the first 5xx. Retry three times with backoff.")
    done_evidence = [{"revision": "1", "submittedAt": ago(25 * 60),
                      "decision": {"decision": "CONFIRM", "decidedAt": ago(24 * 60), "decidedByType": "USER", "note": None},
                      "evidence": {"claim": "Uploads retry three times on a 5xx, with backoff.", "gaps": [], "checks": []}}]

    branch = lambda name, commits, merged=False: {"isolationStatus": "worktree", "branch": name, "worktreeBranch": name,
                                                  "baseSha": "a" * 40, "worktreeDirty": False, "branchCommits": commits,
                                                  "branchMerged": merged, "mergeStatus": "merged" if merged else None,
                                                  "mergeTarget": "main" if merged else None}
    return {
        "failed": {"taskId": failed_id, "task": failed, "evidence": [], "owner": None,
                   "session": {"taskId": failed_id, **branch("orbit/task-fix-date-dependent-failures",
                                                            [_commit("16f4a7e2b9c1", 'docs: rename the second "Drive" heading', ago(80))])}},
        "running": {"taskId": running_id, "task": running, "evidence": [], "owner": None,
                    "session": {"taskId": running_id, **branch("orbit/task-add-retry-to-the-upload-step", [
                        _commit("a1b2c3d4e5f6", "feat(upload): retry 5xx with backoff", ago(5)),
                        _commit("a2b2c3d4e5f6", "test(upload): three retries then give up", ago(4)),
                        _commit("a3b2c3d4e5f6", "refactor(upload): one request helper", ago(3))])}},
        "needs-you": {"taskId": needs_id, "task": needs, "evidence": needs_evidence, "owner": needs_owner,
                      "session": {"taskId": needs_id, **branch("orbit/task-add-retry-to-the-upload-step", [
                          _commit("b1c2d3e4f5a6", "upload: step 1", ago(40)), _commit("b2c2d3e4f5a6", "upload: step 2", ago(30)),
                          _commit("b3c2d3e4f5a6", "upload: step 3", ago(20)), _commit("b4c2d3e4f5a6", "upload: step 4", ago(10))])}},
        "done": {"taskId": done_id, "task": done, "evidence": done_evidence, "owner": None,
                 "session": {"taskId": done_id, **branch("orbit/task-add-retry-to-the-upload-step", [], merged=True)}},
    }


def reads(state, session_id, workspace_id, now=None):
    """The GET paths (under /api) one state answers, the conversation's own detail aside."""
    s = scenarios(session_id, workspace_id, now)[state]
    t = s["taskId"]
    return {f"/api/tasks/{t}": s["task"], f"/api/tasks/{t}/evidence": s["evidence"],
            f"/api/tasks/{t}/owner-confirmation": s["owner"] or {
                "taskId": t, "title": s["task"]["title"], "status": s["task"]["status"], "projectId": None,
                "completionCriterion": s["task"]["completionCriterion"], "acceptanceCriteria": s["task"]["acceptanceCriteria"],
                "waiting": None, "decisions": [], "ifConfirmed": None, "reviewerReturns": []}}
