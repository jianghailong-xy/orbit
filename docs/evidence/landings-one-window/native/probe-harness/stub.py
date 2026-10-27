#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API the native project sessions
# page and the project's Landings window read (task 34nGbUykKeP4geymwZYB8, owner 2026-10-27,
# docs/mocks/landings-one-window). Copied in shape from
# docs/evidence/landing-check-ready-card/probe-harness/stub.py, with one fixed project:
#
#   yesterday  LY1 Land · Ledger migration order        LANDED 17:42, two generations (the focus)
#   today      LT4 Land · Webhook signature check        LANDED
#              LT3 Land · Session list search            LANDED
#              LT1 Land · Fix the wiki deep link         NOTHING_TO_LAND
#              LM1 Merge project/P1 → main · #12         MERGED, joined to its record PM12
#              LT2 Land · Runner model order             LANDED
#   8–30 days  PM3 a merge into main older than landing sessions (no landingSessionId)
#   Now        LW1 Land · Notification cold start        AWAITING_DECISION (task acceptance failed)
#              LR1 Land · Task page reload               IN_FLIGHT (merge check running, LIVE)
#
# So the sessions page's Landings row reads `1 waiting for a decision · 1 in flight · 3 landed ·
# 1 merged into main today`. Every "today" instant is placed between local midnight and now, so the
# day sections hold whenever the runner photographs them. Every request is logged; anything not
# served is a 404 and lands in not-served.txt. All data is made up.
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"


def iso(t):
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def ago(minutes):
    return iso(datetime.now(timezone.utc) - timedelta(minutes=minutes))


def today(fraction):
    """An instant earlier today, `fraction` of the way from local midnight to now."""
    now = datetime.now().astimezone()
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return iso(midnight + (now - midnight) * fraction)


def yesterday(hour, minute):
    now = datetime.now().astimezone()
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return iso(midnight - timedelta(days=1) + timedelta(hours=hour, minutes=minute))


DAY = 24 * 60
TITLES = {"P1": "Wiki server"}
USER = {"id": "u1", "email": "owner@example.com", "name": "Owner", "role": "MEMBER",
        "createdAt": ago(90 * DAY), "preferences": {"theme": "system"}}
RUNNER = {"id": "r1", "name": "wikova", "displayName": "wikova", "online": True, "status": "ONLINE",
          "version": "0.1.240", "maxConcurrent": 4, "lastHeartbeatAt": ago(0), "capabilities": [],
          "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}]}
AGENT = {"id": "a1", "name": "orbit-macos", "provider": "claude", "lastProvider": "claude",
         "runnerId": "r1", "enabled": True, "enableWorktree": True, "effort": "",
         "workDir": "/srv/orbit", "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}

MEMBERSHIP = {"projectId": "P1", "projectTitle": TITLES["P1"], "projectStatus": "OPEN", "role": "TASK"}

C1 = {"id": "C1", "publicId": "C1", "title": "Wiki server", "status": "AWAITING_INPUT",
      "runStatus": "AWAITING_INPUT", "runState": "AWAITING_INPUT", "sessionState": "AWAITING_INPUT",
      "agentId": "a1", "assignedRunnerId": "r1", "provider": "claude",
      "projectId": "P1", "projectTitle": TITLES["P1"],
      "projectMembership": dict(MEMBERSHIP, role="COORDINATOR"),
      "lastAssistantText": "Watching the landings of 2 tasks",
      "createdAt": ago(5 * DAY), "updatedAt": ago(2), "lastTurnAt": ago(2)}

S4 = {"id": "S4", "publicId": "S4", "title": "Task page reload", "status": "SUCCEEDED",
      "runStatus": "SUCCEEDED", "runState": "SUCCEEDED", "sessionState": "SUCCEEDED",
      "agentId": "a1", "assignedRunnerId": "r1", "provider": "claude", "taskId": "T5",
      "projectId": "P1", "projectTitle": TITLES["P1"], "projectMembership": MEMBERSHIP,
      "lastAssistantText": "Recap · the task page reads back before it opens the button",
      "createdAt": ago(40), "updatedAt": ago(9), "lastTurnAt": ago(9)}
S5 = dict(S4, id="S5", publicId="S5", title="Notification cold start", taskId="T4",
          lastAssistantText="Recap · a cold start waits for the session list",
          createdAt=ago(70), updatedAt=ago(25), lastTurnAt=ago(25))

# (id, title, subject, settledAs, settledAt, createdAt, taskId, promotionId)
SETTLED = [
    ("LY1", "Land · Ledger migration order", "TASK", "LANDED", yesterday(17, 42), yesterday(16, 20), "T1", None),
    ("LT4", "Land · Webhook signature check", "TASK", "LANDED", today(0.55), today(0.5), "T6", None),
    ("LT3", "Land · Session list search", "TASK", "LANDED", today(0.62), today(0.58), "T7", None),
    ("LT1", "Land · Fix the wiki deep link", "TASK", "NOTHING_TO_LAND", today(0.7), today(0.66), "T8", None),
    ("LM1", "Merge project/P1 → main · #12", "PROMOTION", "MERGED", today(0.8), today(0.72), None, "PM12"),
    ("LT2", "Land · Runner model order", "TASK", "LANDED", today(0.9), today(0.85), "T2", None),
]
# (id, title, state, createdAt, taskId)
OPEN = [
    ("LW1", "Land · Notification cold start", "AWAITING_DECISION", ago(18), "T4"),
    ("LR1", "Land · Task page reload", "IN_FLIGHT", ago(7), "T5"),
]


def landing_row(lid, title, subject, state, settled_as, settled_at, created):
    return {"id": lid, "publicId": lid, "title": title,
            "status": "SUCCEEDED" if settled_at else "RUNNING",
            "runStatus": "SUCCEEDED" if settled_at else "RUNNING",
            "runState": "SUCCEEDED" if settled_at else "RUNNING",
            "sessionState": "SUCCEEDED" if settled_at else "RUNNING",
            "lifecycleState": "COMPLETED" if settled_at else "OPEN",
            "sessionKind": "LANDING", "agentId": "a1", "assignedRunnerId": "r1",
            "projectId": "P1", "projectTitle": TITLES["P1"], "projectMembership": MEMBERSHIP,
            "createdAt": created, "updatedAt": settled_at or ago(0), "lastTurnAt": settled_at or ago(0),
            "landing": {"subject": subject, "state": state, "settledAs": settled_as,
                        "settledAt": settled_at}}


def rows():
    out = [landing_row(l, t, s, "SETTLED", a, at, c) for (l, t, s, a, at, c, _, _) in SETTLED]
    out += [landing_row(l, t, "TASK", st, None, None, c) for (l, t, st, c, _) in OPEN]
    return out


PASSED = {"exitCode": 0, "expectedExitCode": 0, "timedOut": False}


def entry(kind, text, at, *, claim=1, round=None, phase=None, check=None, data=None, seq=1, actor="RUNNER"):
    return {"id": "e-%s-%s-%s" % (kind, seq, at), "seq": seq, "kind": kind, "at": at, "claim": claim,
            "round": round, "check": check, "phase": phase, "step": None, "actor": {"type": actor},
            "reason": None, "data": data, "text": text}


def plus(at, minutes):
    return iso(datetime.strptime(at, "%Y-%m-%dT%H:%M:%S.000Z").replace(tzinfo=timezone.utc)
               + timedelta(minutes=minutes))


def attempt(job, kind, state, started, *, check=None, liveness=None, heartbeat=None, push=False,
            task=None, source=None):
    return {"jobId": job, "kind": kind, "state": state, "generation": 1, "phase": "CHECK", "round": 1,
            "step": None, "claim": 1, "runnerName": "wikova", "sourceSessionId": source,
            "targetRef": "refs/heads/project/P1", "startedAt": started,
            "heartbeatAt": heartbeat or started, "outputMovedAt": ago(0.05) if liveness == "LIVE" else started,
            "progressProtocol": "v2", "check": check, "liveness": liveness, "blockingReason": None,
            "timedOut": False, "limitSeconds": 600, "retryable": False, "pushBoundaryPassed": push}


def view(lid):
    """`GET /sessions/:id`'s landing view for one of the window's landings."""
    for (l, title, subject, settled_as, settled_at, created, task, promo) in SETTLED:
        if l != lid:
            continue
        if l == "LY1":
            # Two generations: the first failed its check, the coordinator ran it again (board 03 f).
            g1 = [entry("ENQUEUED", "Task marked done · queued to land on project/P1", plus(created, 0), seq=1),
                  entry("CLAIMED", "Claimed by runner wikova · claim 1", plus(created, 1), seq=2),
                  entry("CHECK_FINISHED", "Merge check failed · exit 1 after 18m 02s", plus(created, 19), round=1,
                        check={"name": "MERGE_CHECK", "index": 1},
                        data={"exitCode": 1, "expectedExitCode": 0, "timedOut": False}, seq=3),
                  entry("HANDED_TO", "Asked the coordinator to fix it", plus(created, 19), seq=4,
                        data={"assignee": "COORDINATOR"}, actor="PLATFORM")]
            g2 = [entry("NEXT_GENERATION", "Rerun by the coordinator · the emulator timed out booting",
                        plus(created, 52), seq=5, actor="SESSION"),
                  entry("ENQUEUED", "Queued again to land on project/P1", plus(created, 52), seq=6),
                  entry("CHECK_FINISHED", "Merge check passed · 16m 48s", plus(created, 81), claim=1, round=1,
                        check={"name": "MERGE_CHECK", "index": 1}, data=PASSED, seq=7),
                  entry("RESULT", "Landed on project/P1 · 9c2e7d1", settled_at, data={"state": "LANDED"}, seq=8)]
            sections = [{"title": "Generation 1", "jobId": "jY1", "kind": "LAND_TASK", "generation": 1,
                         "state": "CHECK_FAILED", "entries": g1},
                        {"title": "Generation 2", "jobId": "jY2", "kind": "LAND_TASK", "generation": 2,
                         "state": "LANDED", "entries": g2}]
            current = attempt("jY2", "LAND_TASK", "LANDED", plus(created, 53), push=True, source="S6")
        elif l == "LM1":
            sections = [{"title": "Merge check · 1", "jobId": "jM1", "kind": "CHECK_PROMOTION", "generation": 1,
                         "state": "READY", "entries": [
                             entry("CHECK_STARTED", "Merge check started on the combined tree", plus(created, 1),
                                   round=1, check={"name": "MERGE_CHECK", "index": 1}, seq=1),
                             entry("CHECK_FINISHED", "Merge check passed · 17m 41s", plus(created, 19), round=1,
                                   check={"name": "MERGE_CHECK", "index": 1}, data=PASSED, seq=2),
                             entry("RESULT", "Ready to merge into main", plus(created, 19),
                                   data={"state": "READY"}, seq=3)]},
                        {"title": "Merge to main · 1", "jobId": "jM2", "kind": "LAND_PROMOTION", "generation": 1,
                         "state": "MERGED", "entries": [
                             entry("CLAIMED", "Claimed by runner wikova · claim 1", plus(created, 20), seq=4),
                             entry("RESULT", "Landed on main · 3f1c2a9", settled_at, data={"state": "LANDED"}, seq=5)]}]
            current = attempt("jM2", "LAND_PROMOTION", "MERGED", plus(created, 20), push=True)
        else:
            sections = [{"title": "Generation 1", "jobId": "j" + l, "kind": "LAND_TASK", "generation": 1,
                         "state": settled_as, "entries": [
                             entry("ENQUEUED", "Task marked done · queued to land on project/P1", created, seq=1),
                             entry("CLAIMED", "Claimed by runner wikova · claim 1", plus(created, 1), seq=2),
                             entry("RESULT", "Nothing to push · the branch carried no commits"
                                   if settled_as == "NOTHING_TO_LAND" else "Landed on project/P1 · 4b1d0e2",
                                   settled_at, data={"state": settled_as}, seq=3)]}]
            current = attempt("j" + l, "LAND_TASK", settled_as, plus(created, 1), push=True, source="S4")
        return {"sessionId": l, "projectId": "P1", "subject": subject, "taskId": task, "promotionId": promo,
                "episode": 12 if l == "LM1" else 1, "openedAt": created, "settledAt": settled_at,
                "settledAs": settled_as, "phase": "CHECK", "round": 1,
                "checks": [dict(PASSED, name="MERGE_CHECK", command="npm test", durationMs=1_061_000)],
                "liveness": None, "blockingReason": None, "currentAttempt": current, "todos": [],
                "generations": [], "timeline": {"sections": sections, "facts": [], "truncated": False}}
    if lid == "LW1":
        created = OPEN[0][3]
        current = attempt("jW1", "LAND_TASK", "CHECK_FAILED", plus(created, 1), source="S5")
        return {"sessionId": "LW1", "projectId": "P1", "subject": "TASK", "taskId": "T4", "promotionId": None,
                "episode": 1, "openedAt": created, "settledAt": None, "settledAs": None,
                "phase": "CHECK", "round": 1,
                "checks": [{"name": "MERGE_CHECK", "command": "npm test", "exitCode": 1, "expectedExitCode": 0,
                            "timedOut": False, "durationMs": 232_000}],
                "liveness": None, "blockingReason": None, "currentAttempt": current, "todos": [],
                "generations": [], "timeline": {"sections": [{
                    "title": "Generation 1", "jobId": "jW1", "kind": "LAND_TASK", "generation": 1,
                    "state": "CHECK_FAILED", "entries": [
                        entry("ENQUEUED", "Task marked done · queued to land on project/P1", created, seq=1),
                        entry("CLAIMED", "Claimed by runner wikova · claim 1", plus(created, 1), seq=2),
                        entry("CHECK_FINISHED", "Merge check failed · exit 1 after 3m 52s", plus(created, 5),
                              round=1, check={"name": "MERGE_CHECK", "index": 1},
                              data={"exitCode": 1, "expectedExitCode": 0, "timedOut": False}, seq=3),
                        entry("RESULT", "Check failed · nothing was pushed", plus(created, 5),
                              data={"state": "CHECK_FAILED"}, seq=4),
                        entry("HANDED_TO", "Asked the coordinator to fix it", plus(created, 5),
                              data={"assignee": "COORDINATOR"}, seq=5, actor="PLATFORM")]}],
                    "facts": [], "truncated": False}}
    if lid == "LR1":
        started = ago(6.2)
        check = {"name": "MERGE_CHECK", "index": 1, "count": 1, "budgetSeconds": 1800, "startedAt": started}
        current = attempt("jR1", "LAND_TASK", "RUNNING", ago(7), check=check, liveness="LIVE",
                          heartbeat=ago(0), source="S4")
        return {"sessionId": "LR1", "projectId": "P1", "subject": "TASK", "taskId": "T5", "promotionId": None,
                "episode": 1, "openedAt": ago(7), "settledAt": None, "settledAs": None,
                "phase": "CHECK", "round": 1, "checks": [], "liveness": "LIVE", "blockingReason": None,
                "currentAttempt": current, "todos": [], "generations": [],
                "timeline": {"sections": [{
                    "title": "Generation 1", "jobId": "jR1", "kind": "LAND_TASK", "generation": 1,
                    "state": "RUNNING", "entries": [
                        entry("ENQUEUED", "Task marked done · queued to land on project/P1", ago(7), seq=1),
                        entry("CLAIMED", "Claimed by runner wikova · claim 1", ago(6.8), seq=2),
                        entry("CHECK_STARTED", "Merge check started on the combined tree", started, round=1,
                              check={"name": "MERGE_CHECK", "index": 1}, seq=3)]}],
                    "facts": [], "truncated": False}}
    return None


def detail(lid):
    landing = view(lid)
    if landing is None:
        return None
    row = next(r for r in rows() if r["id"] == lid)
    return dict(row, landing=landing)


def merged_record(pid, at, landing_session, tasks, sha, automatic):
    return {"promotionId": pid, "state": "MERGED", "sourceKind": "PROJECT_BRANCH",
            "sourceRef": "refs/heads/project/P1", "sourceSha": "a" * 40, "upstreamRef": "refs/heads/main",
            "commitsAhead": len(tasks), "filesChanged": 6,
            "tasks": [{"taskId": "T%d" % i, "title": t} for i, t in enumerate(tasks, 1)],
            "taskIds": ["T%d" % i for i, _ in enumerate(tasks, 1)],
            "checks": [{"name": "MERGE_CHECK", "command": "npm test", "expectedExitCode": 0, "exitCode": 0,
                        "timedOut": False, "durationMs": 17 * 60_000 + 41_000}],
            "conflicts": [], "blockedReason": None, "upstreamShaChecked": "b" * 40,
            "landsTreeSha": "5e5bfca" + "0" * 33, "landsAs": "MERGE_COMMIT", "askedAt": None,
            "upstream": {"syncedAt": None, "conflicts": False}, "recheckedAt": None, "recheck": None,
            "decidedAt": None, "landingSessionId": landing_session, "onPass": None,
            "cancelRequested": False, "pushBoundaryPassed": True, "execution": None,
            "merged": {"sha": sha + "0" * 33, "at": at, "automatic": automatic, "byUserId": None,
                       "revert": None}}


def merges():
    return [merged_record("PM12", SETTLED[4][4], "LM1",
                          ["Ledger migration order", "Wiki review link (#2)"], "3f1c2a9", True),
            merged_record("PM3", ago(9 * DAY), None, ["Search index warm-up"], "8d5a868", False)]


def integration():
    started = ago(7)
    job = {"jobId": "jR1", "kind": "LAND_TASK", "state": "RUNNING", "phase": "CHECK", "generation": 1,
           "startedAt": started, "queuedAt": ago(7.5), "heartbeatAt": ago(0), "runnerName": "wikova",
           "retriedBy": None, "timedOut": False, "limitSeconds": 600, "retryable": False, "claim": 1,
           "round": 1, "check": {"name": "MERGE_CHECK", "index": 1, "count": 1, "budgetSeconds": 1800,
                                 "startedAt": ago(6.2)},
           "stepStartedAt": ago(6.2), "outputMovedAt": ago(0.05), "progressProtocol": "v2",
           "typicalMs": 9 * 60_000, "liveness": "LIVE", "landingSessionId": "LR1",
           "taskId": "T5", "taskTitle": "Task page reload"}
    flight = {k: job.get(k) for k in ("taskTitle", "kind", "state", "phase", "startedAt", "heartbeatAt",
                                      "jobId", "landingSessionId", "taskId", "runnerName", "claim",
                                      "round", "check", "stepStartedAt", "outputMovedAt",
                                      "progressProtocol", "typicalMs", "liveness")}
    flight["runner"] = "wikova"
    flight["waitMs"] = 30_000
    return {"line": "PROJECT_BRANCH", "ref": "project/P1", "upstreamRef": "main",
            "integratingCount": 1, "queuedCount": 0, "mergeCheckOnTip": "PASSING",
            "inFlight": flight, "inFlightJobs": [job],
            "landTasks": [{"taskId": "T5", "taskTitle": "Task page reload",
                           "integration": {"state": "RUNNING", "jobId": "jR1",
                                           "landTask": {"jobId": "jR1", "state": "RUNNING", "phase": "CHECK",
                                                        "landingSessionId": "LR1", "generation": "1",
                                                        "targetRef": "refs/heads/project/P1",
                                                        "startedAt": started}}}]}


def summary(pid):
    return {"id": pid, "publicId": pid, "title": TITLES[pid], "status": "OPEN",
            "goal": "The wiki server serves every space.", "createdAt": ago(20 * DAY),
            "updatedAt": ago(30), "lastActivityAt": ago(2), "_count": {"tasks": 91},
            "startedAt": ago(19 * DAY), "mainBranch": "main",
            "taskCounts": {"done": 79, "failed": 1, "total": 91}}


def document(pid):
    return {"id": pid, "publicId": pid, "title": TITLES[pid], "status": "OPEN",
            "goal": "The wiki server serves every space.", "instructions": "Probe instructions.",
            "createdAt": ago(20 * DAY), "updatedAt": ago(30), "coordinatorEnabled": True,
            "configRevision": "1", "coordinatorSessionId": "C1",
            "_count": {"tasks": 91}, "tasksByStatus": {"DONE": 79, "FAILED": 1, "OPEN": 11},
            "acceptanceCriteriaItems": [], "blockers": {"open": [], "resolved": [], "resolvedCount": 0},
            "startedAt": ago(19 * DAY), "pausedAt": None, "maxConcurrentTasks": 3}


def check_log():
    chunk = lambda seq, text: {"jobId": "jW1", "claim": 1, "round": 1,
                               "check": {"name": "MERGE_CHECK", "index": 1}, "seq": seq,
                               "text": text, "truncatedBytes": 0, "at": ago(13)}
    return {"jobId": "jW1", "nextCursor": None, "entries": [
        chunk(0, "> orbit@1.0.0 test\n> vitest run src/notifications\n\n"),
        chunk(1, " FAIL  src/notifications/cold-start.test.ts > opens the session after a cold start\n"
                 "AssertionError: expected the session page but the list was open\n"
                 " Test Files  1 failed | 4 passed (5)\n"),
    ]}


_NO_BODY = object()
EMPTY = ["providers", "providers/mine", "providers/pools", "providers/shared-pools", "session-tags",
         "session-folders", "task-lists", "watches", "tasks/active", "tasks/counts", "notifications",
         "wiki/spaces"]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        with open(LOG, "a") as f:
            f.write("%s %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

    def note(self, line):
        with open(LOG, "a") as f:
            f.write("%s %s\n" % (datetime.now().strftime("%H:%M:%S"), line))

    def send(self, status, body=_NO_BODY):
        # `null` is a body: the promotions door answers a bare JSON null for "asking nothing".
        data = b"" if body is _NO_BODY else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlparse(self.path)
        parts = [p for p in path.path.split("/") if p]
        query = parse_qs(path.query)
        if parts == ["__log"]:
            try:
                data = open(LOG, "rb").read()
            except OSError:
                data = b""
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if parts == ["api", "events"]:
            return self.stream()
        if parts == ["api", "users", "me"]:
            return self.send(200, USER)
        if parts == ["api", "agents"]:
            return self.send(200, [AGENT])
        if parts == ["api", "agents", "a1"]:
            return self.send(200, AGENT)
        if parts == ["api", "runners"]:
            return self.send(200, [RUNNER])
        if parts == ["api", "runners", "r1"]:
            return self.send(200, RUNNER)

        if parts == ["api", "sessions"]:
            project = (query.get("projectId") or [None])[0]
            include = (query.get("includeLanding") or ["0"])[0] == "1"
            view_name = (query.get("view") or ["open"])[0]
            members = [C1, S4, S5]
            if project == "P1" and include:
                landings = [r for r in rows()
                            if (r["lifecycleState"] == "COMPLETED") == (view_name.lower() == "completed")]
                return self.send(200, (members if view_name.lower() != "completed" else []) + landings)
            return self.send(200, members if view_name.lower() != "completed" else [])
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"]:
            sid, more = parts[2], parts[3:]
            found = detail(sid)
            if found is not None:
                if more == []:
                    return self.send(200, found)
                if more == ["landing", "log"]:
                    return self.send(200, check_log())
            row = {"S4": S4, "S5": S5, "C1": C1}.get(sid)
            if row is not None:
                if more == []:
                    return self.send(200, row)
                if more == ["events", "page"]:
                    return self.send(200, {"events": [], "hasMore": False})
                if more == ["events"]:
                    return self.send(200, {"items": [], "nextCursor": None, "events": []})
                if more and more[0] in ("retry-message", "capabilities", "owner-confirmation", "watches",
                                        "owner-items", "attribution", "created-tasks", "turns"):
                    body = {}
                    if more[0] == "owner-items":
                        body = {"needsYou": [], "withCoordinator": []}
                    if more[0] == "turns":
                        body = []
                    return self.send(200, body)

        if parts == ["api", "tasks", "page"]:
            return self.send(200, {"items": [], "nextCursor": None})

        if len(parts) >= 2 and parts[:2] == ["api", "projects"]:
            rest = parts[2:]
            if not rest or rest == ["sidebar"]:
                return self.send(200, [summary("P1")])
            pid = rest[0]
            if pid in TITLES:
                if len(rest) == 1:
                    return self.send(200, document(pid))
                if rest[1:] == ["tasks", "page"]:
                    return self.send(200, {"items": [], "nextCursor": None})
                if rest[1:] == ["open-items"]:
                    return self.send(200, {"needsYou": [], "withCoordinator": []})
                if rest[1:] == ["handoffs"]:
                    return self.send(200, [])
                if rest[1:] == ["integration"]:
                    return self.send(200, integration())
                if rest[1:] == ["coordinator", "status"]:
                    return self.send(200, {"projectId": "P1", "state": "LIVE",
                                           "coordination": {"sessionId": "C1"},
                                           "openability": {"canOpen": True, "willCreate": False,
                                                           "refusalCode": None, "refusalDetail": None,
                                                           "requiredAction": None}})
                if rest[1:] == ["promotions", "current"]:
                    return self.send(200, None)
                if rest[1:] == ["promotions", "merged"]:
                    return self.send(200, merges())
                if rest[1:] == ["ready-to-run"]:
                    return self.send(200, {"count": 0, "taskId": None, "title": None})

        if parts[:1] == ["api"] and len(parts) >= 2 and "/".join(parts[1:]) in EMPTY:
            return self.send(200, [])
        self.note("NOT SERVED %s" % self.path)
        return self.send(404, {"statusCode": 404, "message": "not in the probe"})

    def stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            while True:
                self.wfile.write(b": ping\n\n")
                self.wfile.flush()
                time.sleep(10)
        except (BrokenPipeError, ConnectionResetError):
            return

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if parts == ["__reset"]:
            return self.send(200, {"ok": True})
        self.note("POST %s" % self.path)
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    # HTTPServer.server_bind resolves its own name (socket.getfqdn), a reverse lookup that on macOS
    # raises the "Allow Python to find devices on your local network?" prompt over the picture.
    def server_bind(self):
        import socketserver
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = "localhost", self.server_address[1]


if __name__ == "__main__":
    Server(("127.0.0.1", PORT), Handler).serve_forever()
