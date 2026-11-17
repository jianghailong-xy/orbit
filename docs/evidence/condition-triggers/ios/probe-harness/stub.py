#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged into the app): the slice of the Orbit API the iPhone app reads for the
# condition-triggers board (docs/mocks/condition-triggers/01-board.png, frames 2 to 6), task 34yx4AFSjXkHqMNOEbzci.
# Adapted from docs/evidence/criteria-reply-session-line/probe-harness/stub.py.
#
#   GET /api/schedules              the Scheduled page: two WHEN schedules (one that cannot be read), three timed ones,
#                                   and `waitingTasks` with the task waiting for a third OSD (frame 4)
#   GET /api/schedules/s-guard      the inspector's read; GET /api/conditions/c-guard its Condition (frame 6)
#   GET /api/owner-requests         the can't-read card and the 30-day question (frame 6)
#   S-pool                          a conversation whose task_create card starts on a condition (frame 2)
#   S-cap                           a conversation whose schedule create card has a WHEN rule (frame 3)
#   S-cmd                           a conversation whose envelope card asks for a new probe command
#   S-run                           a run its condition started (frame 5)
#   GET /api/tasks/t-osd            the task page with its waiting line
#
# Times are worked out at each read, in Asia/Shanghai (the app runs at TZ=Asia/Shanghai), so "1 min ago" stays true
# however late a test runs. Every request is logged; anything not served is a 404; every write is refused 409. All
# data is made up: no owner's data is read or shown.
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
SH = timezone(timedelta(hours=8))
STARTED = datetime.now(timezone.utc).replace(second=0, microsecond=0)


def iso(t):
    t = t.astimezone(timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def ago(minutes):
    """`minutes` before this read."""
    return iso(datetime.now(timezone.utc) - timedelta(minutes=minutes))


def before(minutes):
    """`minutes` before the stub started: fixed for the whole run."""
    return iso(STARTED - timedelta(minutes=minutes))


def local_today(hour, minute, days=0):
    """Today's (or `days` from today's) hh:mm in Shanghai."""
    d = datetime.now(SH).replace(hour=hour, minute=minute, second=0, microsecond=0) + timedelta(days=days)
    return iso(d)


def fired_at():
    """The guard's firing: 03:12 Shanghai, four days ago."""
    return local_today(3, 12, days=-4)


USER = {"id": "u1", "email": "owner@example.com", "name": "Owner", "role": "MEMBER",
        "createdAt": before(90 * 24 * 60), "preferences": {"theme": "system"}}
AGENTS = [{"id": "a1", "name": "HPC", "provider": "claude", "lastProvider": "claude", "runnerId": "hpc",
           "enabled": True, "enableWorktree": False, "effort": "", "workDir": "/srv/ceph-ops",
           "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True},
          {"id": "a2", "name": "apiserver", "provider": "claude", "lastProvider": "claude", "runnerId": "hpc",
           "enabled": True, "enableWorktree": True, "effort": "", "workDir": "/srv/apiserver",
           "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}]
CLAUDE_MODELS = [{"value": "claude-opus-5-5", "label": "Opus 5.5", "reasoningLevels": ["low", "medium", "high", "max"]}]


def runner():
    return {"id": "hpc", "name": "workstation-gpu", "displayName": "workstation-gpu", "hostname": "workstation",
            "online": True, "status": "ONLINE", "version": "0.1.261", "maxConcurrent": 8, "activeSessions": 1,
            "lastHeartbeatAt": ago(0), "capabilities": ["condition-probe/v1"],
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.325", "auth": "yes"}],
            "modelCatalog": {"claude": CLAUDE_MODELS}, "runtimeDefaultModels": {"claude": "claude-opus-5-5"}}


GUARD_COMMAND = "ceph df -f json | jq .stats.total_used_raw_ratio"
NEW_COMMAND = "ceph df -f json | jq '.stats.total_used_raw_bytes / .stats.total_bytes * 100'"
OSD_COMMAND = "ceph osd stat -f json | jq .num_in_osds"


def guard_condition(command=GUARD_COMMAND):
    return {"text": "Raw used above 90%", "command": command, "compare": {"op": "GT", "value": 90},
            "holdSeconds": 600, "rearm": {"op": "LT", "value": 85}, "intervalSeconds": 300, "unit": "%",
            "timeoutSeconds": 20, "repeatSeconds": None}


def guard_rule(condition_id="c-guard", command=GUARD_COMMAND):
    return {"kind": "WHEN", "conditionId": condition_id, "runsPerWeek": 3, "condition": guard_condition(command)}


MON_RULE = {"kind": "WHEN", "conditionId": "c-mon", "runsPerWeek": 3,
            "condition": {"text": "Root disk below 5%", "command": "df --output=pcent / | tail -1 | tr -dc 0-9",
                          "compare": {"op": "LT", "value": 5}, "holdSeconds": 0, "rearm": None,
                          "intervalSeconds": 300, "unit": "%", "timeoutSeconds": 20, "repeatSeconds": None}}


def schedule(sid, title, rule, workspace="a1", workspace_name="HPC", next_due=None, condition=None, **extra):
    row = {"id": sid, "title": title, "intent": title, "prompt": title, "rule": rule, "timezone": "Asia/Shanghai",
           "workspaceId": workspace, "workspaceName": workspace_name, "agentId": None, "accessLevel": "CHECK_ONLY",
           "runLimitMinutes": 30, "runsPerWeek": rule.get("runsPerWeek", 7),
           "envelope": {"workspaceId": workspace, "accessLevel": "CHECK_ONLY", "runsPerWeek": rule.get("runsPerWeek", 7),
                        "runLimitMinutes": 30, "commandHash": "a1b2" if rule["kind"] == "WHEN" else None},
           "state": "ACTIVE", "heldReason": None, "endedReason": None, "note": None, "revision": 1, "startAt": None,
           "endAt": None, "nextDueAt": next_due, "consecutiveFailures": 0, "createdFromSessionId": "S-cap",
           "createdAt": before(4 * 24 * 60), "endedAt": None, "lastRun": None, "pausedAt": None,
           "condition": condition}
    row.update(extra)
    return row


def guard_reading():
    return {"id": "c-guard", "text": "Raw used above 90%", "unit": "%", "state": "WAITING", "lastValue": 6.9,
            "lastSampleAt": ago(1)}


def guard_run():
    at = fired_at()
    ended = iso(datetime.fromisoformat(at.replace("Z", "+00:00")) + timedelta(minutes=9))
    key = "above-90@" + datetime.fromisoformat(at.replace("Z", "+00:00")).astimezone(SH).strftime("%b %-d")
    return {"id": "r-guard", "scheduleId": "s-guard", "scheduleRevision": 1, "plannedAt": at, "trigger": "CONDITION",
            "state": "CHANGED", "attempt": 1, "startedAt": at, "endedAt": ended, "sessionId": "S-run",
            "key": key, "summary": "Raw used 90.4%. Cause: old snapshots in kubernetes.", "failureReason": None,
            "heldReason": None, "reasonText": None, "session": {"id": "S-run", "state": "OPEN"}}


def schedules():
    codex_last = {"id": "r-codex", "scheduleId": "s-codex", "plannedAt": local_today(10, 0), "trigger": "SCHEDULED",
                  "state": "NO_CHANGE", "startedAt": local_today(10, 0), "endedAt": local_today(10, 4),
                  "sessionId": None, "key": "codex@0.49.0", "summary": "No change"}
    return [
        schedule("s-guard", "Ceph capacity guard", guard_rule(), condition=guard_reading()),
        schedule("s-mon", "Mon disk guard", MON_RULE,
                 condition={"id": "c-mon", "text": "Root disk below 5%", "unit": "%", "state": "UNKNOWN",
                            "lastValue": 5, "lastSampleAt": ago(16)}),
        schedule("s-codex", "Codex stable check", {"kind": "DAILY", "time": "10:00"}, "a2", "apiserver",
                 next_due=local_today(10, 0, days=1), lastRun=codex_last),
        schedule("s-notes", "Release notes draft", {"kind": "DAILY", "time": "17:00"}, "a2", "apiserver",
                 next_due=local_today(17, 0)),
        schedule("s-sweep", "Nightly pg spec sweep", {"kind": "DAILY", "time": "02:00"}, "a2", "apiserver",
                 next_due=local_today(2, 0, days=1)),
    ]


def waiting_tasks():
    return [{"id": "t-osd", "title": "Set kubernetes pool to 3 copies", "workspaceId": "a1", "workspaceName": "HPC",
             "condition": {"id": "c-osd", "text": "3 or more OSDs are in", "unit": "in", "state": "WAITING",
                           "lastValue": 2, "lastSampleAt": ago(3)}}]


def conditions():
    fired = fired_at()
    ready = iso(datetime.fromisoformat(fired.replace("Z", "+00:00")) + timedelta(days=1, hours=6, minutes=28))
    base = {"workspaceId": "a1", "probe": {"command": GUARD_COMMAND, "timeoutSeconds": 20},
            "trueSince": None, "unknownSince": None, "unknownReason": None, "failedChecks": 0,
            "approvedAt": before(4 * 24 * 60), "taskId": None, "createdAt": before(4 * 24 * 60), "endedAt": None,
            "keepsWorkspaceAwake": False, "runnerName": "workstation-gpu", "samples": []}
    guard = dict(base, id="c-guard", text="Raw used above 90%", unit="%", compare={"op": "GT", "value": 90},
                 holdSeconds=600, rearm={"op": "LT", "value": 85}, intervalSeconds=300, repeatSeconds=None,
                 state="WAITING", lastSampleAt=ago(1), lastValue=6.9, lastOutcome="VALUE", lastReadAt=ago(1),
                 firedAt=fired, scheduleId="s-guard",
                 events=[{"at": ready, "kind": "READY_AGAIN", "value": 82.9, "runId": None, "repeat": False},
                         {"at": fired, "kind": "FIRED", "value": 90.4, "runId": "r-guard", "repeat": False}])
    mon = dict(base, id="c-mon", text="Root disk below 5%", unit="%", compare={"op": "LT", "value": 5},
               probe={"command": MON_RULE["condition"]["command"], "timeoutSeconds": 20}, holdSeconds=0, rearm=None,
               intervalSeconds=300, repeatSeconds=None, state="UNKNOWN", lastSampleAt=ago(1), lastValue=5,
               lastOutcome="TIMEOUT", lastReadAt=ago(16), unknownSince=ago(1), unknownReason="TIMEOUT",
               failedChecks=3, firedAt=None, scheduleId="s-mon", events=[])
    osd = dict(base, id="c-osd", text="3 or more OSDs are in", unit="in", compare={"op": "GTE", "value": 3},
               probe={"command": OSD_COMMAND, "timeoutSeconds": 20}, holdSeconds=0, rearm=None, intervalSeconds=300,
               repeatSeconds=None, state="WAITING", lastSampleAt=ago(3), lastValue=2, lastOutcome="VALUE",
               lastReadAt=ago(3), firedAt=None, scheduleId=None, taskId="t-osd", events=[])
    return {"c-guard": guard, "c-mon": mon, "c-osd": osd}


def guard_detail():
    s = schedules()[0]
    created = {"scheduleId": "s-guard", "title": "Ceph capacity guard", "revision": 1, "changedBy": "USER",
               "sessionId": "S-cap", "before": None,
               "after": {"accessLevel": "CHECK_ONLY", "envelope": s["envelope"]},
               "undoOfRevision": None, "undoneByRevision": None, "createdAt": before(4 * 24 * 60), "undo": None}
    return {"schedule": s, "readBack": None, "lastRun": None, "recentRuns": [guard_run()], "findings": [],
            "usage": {"since": before(30 * 24 * 60), "runs": 1, "minutes": 12, "costUsd": None},
            "history": [created], "pendingCards": []}


def owner_requests():
    return [
        {"id": "o-mon", "kind": "CONDITION_UNKNOWN", "state": "PENDING", "title": "Can't read: Root disk below 5%",
         "why": "The check timed out 3 times in a row. The last reading was 5%, 16 minutes ago. It does not fire while "
                "it cannot be read, and its hold starts over. This closes by itself when a check reads again.",
         "conditionId": "c-mon", "workspaceId": "a1", "askedBySessionId": "S-cap", "options": None,
         "blocksTaskIds": [], "createdAt": ago(1)},
        {"id": "o-osd", "kind": "CONDITION_STILL_WAITING", "state": "PENDING",
         "title": "Still waiting for 3 or more OSDs are in. Keep waiting?",
         "why": "This task starts when 3 or more OSDs are in, and that has not held in 30 days. Keep waiting asks "
                "again in 30 days. Stop ends the check; the task stays open, and you can start it yourself.",
         "options": [{"label": "Keep waiting", "description": "Ask again in 30 days."},
                     {"label": "Stop", "description": "End the check. The task stays open."}],
         "recommendedOption": 0, "conditionId": "c-osd", "workspaceId": "a1", "askedBySessionId": "S-pool",
         "blocksTaskIds": [], "createdAt": ago(40)},
    ]


def ev(seq, typ, turn, payload, ts):
    return {"seq": seq, "type": typ, "ts": ts, "turnId": turn, "payload": payload}


def exchange(seq, turn, ask, ask_at, reply, reply_at):
    return [ev(seq, "user", turn, {"text": ask}, ask_at),
            ev(seq + 1, "assistant", turn, {"text": reply, "messageId": f"m{seq}"}, reply_at),
            ev(seq + 2, "result", turn, {"subtype": "success", "result": "done"}, reply_at)]


def task_create_input():
    lines = {"startsWhen": "3 or more OSDs are in",
             "checked": "Once. Checked every 5 min on workstation-gpu, no model.",
             "command": OSD_COMMAND, "today": "2 in. Not yet.", "ifNever": "Asks you after 30 days of waiting",
             "awake": None}
    return {"title": "Set kubernetes pool to 3 copies", "assigneeId": "a1",
            "description": "When a third OSD is in, I check the cluster again and propose setting kubernetes to "
                           "size 3. Nothing changes until you approve.",
            "acceptanceCriteria": "The kubernetes pool reads size 3 after the owner approved the change.",
            "completionCriterion": "OWNER_CONFIRMED",
            "startWhen": {"text": "3 or more OSDs are in", "command": OSD_COMMAND, "compare": {"op": "GTE", "value": 3},
                          "unit": "in", "baseline": {"value": 2}},
            "preview": {"taskCount": 1, "startingNow": 0, "blocked": 0, "needsManualStart": 0, "notDispatchable": 0,
                        "scheduled": 0, "waitingForCondition": 1, "awaitingProjectStart": 0, "internalEdges": 0,
                        "externalEdges": 0, "lists": [],
                        "assignees": [{"id": "a1", "name": "HPC", "hasRunner": True}],
                        "tasks": [{"title": "Set kubernetes pool to 3 copies", "listId": None, "dependsOnRefs": [],
                                   "dependsOnTaskIds": [], "ref": None, "startWhen": lines}],
                        "titlesTruncated": 0}}


def create_card():
    return {"id": "q-cap", "kind": "CREATE", "state": "PENDING", "askedBy": "SESSION", "askedBySessionId": "S-cap",
            "scheduleId": None, "createdAt": before(5), "decidedAt": None, "resultRevision": None,
            "decision": {"allow": "Create", "decline": "Not now"}, "title": "Ceph capacity guard",
            "readBack": "Whenever Ceph's raw use goes above 90%, I look at what is using the space and propose what "
                        "to clear. I tell you each time it crosses.",
            "intent": "Tell me when Ceph's raw use goes above 90%, and look at what can be cleared.",
            "when": {"rule": guard_rule(None), "timezone": None, "firstRunAt": None,
                     "text": "Raw used above 90% for 10 min",
                     "condition": {"text": "Raw used above 90% for 10 min",
                                   "detail": "Fires again only after it drops below 85%. Checked every 5 min on "
                                             "workstation-gpu, no model.",
                                   "command": GUARD_COMMAND, "repeat": None, "awake": None}},
            "runsIn": {"workspaceId": "a1", "workspaceName": "HPC", "engine": "claude"},
            "may": {"accessLevel": "CHECK_ONLY"}, "costs": {"runsPerWeek": 3, "runLimitMinutes": 30},
            "today": {"key": "below-90", "summary": "6.9%. Nothing to report.", "text": "6.9%. Nothing to report."},
            "notice": "You'll hear when it crosses 90%, and if Ceph can't be read.", "proposed": None,
            "envelope": None}


def widen_card():
    lines = {"runsIn": {"workspaceId": "a1", "workspaceName": "HPC", "engine": "claude"},
             "may": {"accessLevel": "CHECK_ONLY"}, "costs": {"runsPerWeek": 3, "runLimitMinutes": 30}}
    return {"id": "q-cmd", "kind": "UPDATE", "state": "PENDING", "askedBy": "SESSION", "askedBySessionId": "S-cmd",
            "scheduleId": "s-guard", "createdAt": before(3), "decidedAt": None, "resultRevision": None,
            "decision": {"allow": "Allow", "decline": "Keep the approved command"}, "title": "Ceph capacity guard",
            "proposed": {"rule": guard_rule("c-guard", NEW_COMMAND)},
            "envelope": {"widens": ["PROBE_COMMAND"], "now": lines, "asked": lines}}


def fresh_state():
    sessions = {
        "S-pool": {"title": "Ceph pool query", "status": "AWAITING_APPROVAL", "pending": 1,
                   "events": exchange(1, "t1", "Set the kubernetes pool to 3 replicas.", before(30),
                                      "Can't do that as asked: this cluster has only **2 OSDs**, both on workstation. "
                                      "With size 3 the third copy has nowhere to go.", before(29))
                             + exchange(4, "t2", "Hold until the third OSD is in.", before(12),
                                        "Holding, no changes made. I can pick this up by itself when the third OSD "
                                        "is in; closing this chat won't stop it.", before(11))},
        "S-cap": {"title": "Ceph capacity", "status": "AWAITING_INPUT", "pending": 0,
                  "events": exchange(1, "t1", "Tell me when Ceph's raw use goes above 90%, and look at what can be "
                                              "cleared.", before(8),
                                     "I checked just now: raw used is **6.9%** (2.0 of 29.1 TiB), so there is nothing "
                                     "to do today. I can keep an eye on it; closing this chat won't stop it.",
                                     before(6))},
        "S-cmd": {"title": "Ceph capacity guard: the check", "status": "AWAITING_INPUT", "pending": 0,
                  "events": exchange(1, "t1", "Make the guard read the raw bytes instead of the ratio.", before(4),
                                     "That changes the command the guard runs, so it needs your Allow.", before(3))},
        "S-run": {"title": "Ceph capacity guard", "status": "AWAITING_APPROVAL", "pending": 1, "run": True,
                  "events": exchange(1, "t1", "Run of Ceph capacity guard: raw used is 90.4%, above 90% for 10 min.",
                                     fired_at(),
                                     "Raw use went from 84% to 90.4% since the start of the week. Almost all of the "
                                     "growth is in kubernetes: 14 RBD snapshots older than 7 days hold 1.1 TiB. "
                                     "Deleting them brings raw use to about 83%.", fired_at())},
    }
    return {"sessions": sessions}


STATE = fresh_state()


def session_row(sid, s):
    said = [e for e in s["events"] if e["type"] == "assistant"]
    last = said[-1] if said else s["events"][-1]
    status = s["status"]
    return {"id": sid, "title": s["title"], "status": status, "runStatus": status, "runState": status,
            "sessionState": status, "lifecycleState": "OPEN", "filingState": "OPEN", "agentId": "a1",
            "agent": {"id": "a1", "name": "HPC"}, "assignedRunnerId": "hpc", "provider": "claude",
            "model": "claude-opus-5-5", "effort": "high", "permissionMode": "default", "taskId": None,
            "taskTitle": None, "projectId": None, "projectTitle": None, "projectMembership": None,
            "titleManagedByProject": False, "createdAt": s["events"][0]["ts"], "updatedAt": last["ts"],
            "lastTurnAt": last["ts"], "lastAssistantText": last["payload"].get("text", ""),
            "pendingApprovals": s["pending"], "tags": [], "folderId": None,
            "source": "SCHEDULE" if s.get("run") else "USER"}


def approvals(sid):
    if sid == "S-pool":
        return [{"id": "ap-pool", "toolName": "orbit_task_create", "status": "PENDING", "input": task_create_input(),
                 "translation": None}]
    if sid == "S-run":
        return [{"id": "ap-run", "toolName": "Bash", "status": "PENDING",
                 "input": {"command": "rbd snap purge --older-than 7d kubernetes/… (14 images)",
                           "description": "Delete 14 snapshots in kubernetes"}, "translation": None}]
    return []


def schedule_cards(sid):
    if sid == "S-cap":
        return {"run": None, "cards": [create_card()], "records": []}
    if sid == "S-cmd":
        return {"run": None, "cards": [widen_card()], "records": []}
    if sid == "S-run":
        return {"run": guard_run(), "cards": [], "records": []}
    return {"run": None, "cards": [], "records": []}


def task_osd():
    return {"id": "t-osd", "title": "Set kubernetes pool to 3 copies",
            "description": "When a third OSD is in, I check the cluster again and propose setting kubernetes to "
                           "size 3. Nothing changes until you approve.",
            "status": "OPEN", "assigneeId": "a1", "listId": None, "dueDate": None, "projectId": None,
            "completionCriterion": "OWNER_CONFIRMED", "autoRunWhenReady": True, "creatorSessionId": "S-pool",
            "creatorType": "AGENT", "creatorId": "a1", "createdAt": before(11), "updatedAt": before(11),
            "acceptanceCriteria": "The kubernetes pool reads size 3 after the owner approved the change.",
            "runAt": None, "labels": [], "dependsOn": [], "dependedOnBy": [], "comments": [], "sessions": [],
            "assignee": {"id": "a1", "name": "HPC", "model": None},
            "startWhen": {"conditionId": "c-osd", "text": "3 or more OSDs are in", "unit": "in", "state": "WAITING",
                          "lastValue": 2, "lastSampleAt": ago(3), "firedAt": None,
                          "waitingLine": "Waiting for: 3 or more OSDs are in"},
            "dependencyState": "NONE", "blocked": False}


EMPTY_LISTS = {"providers", "providers/mine", "providers/pools", "providers/shared-pools", "session-tags",
               "session-folders", "task-lists", "watches", "share-links", "projects", "projects/sidebar",
               "notifications", "wiki/spaces", "access-tokens", "tasks/active"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        with open(LOG, "a") as f:
            f.write("%s %s\n" % (datetime.now().strftime("%H:%M:%S.%f")[:-3], fmt % args))

    def send(self, status, body=None):
        data = b"" if body is None else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        text = (self.rfile.read(n) if n else b"").decode("utf-8", "replace")
        with open(LOG, "a") as f:
            f.write("    %s %s body: %s\n" % (self.command, urlparse(self.path).path, text))
        return text

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        parts = [p for p in url.path.split("/") if p]
        path = "/".join(parts[1:])
        if parts == ["__log"]:
            data = open(LOG, "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if parts == ["api", "events"]:
            return self.keepalive()
        if path == "users/me":
            return self.send(200, USER)
        if path == "agents":
            return self.send(200, AGENTS)
        if len(parts) == 3 and parts[1] == "agents":
            found = [a for a in AGENTS if a["id"] == parts[2]]
            return self.send(200, found[0]) if found else self.send(404, {"message": "no agent"})
        if path == "runners":
            return self.send(200, [runner()])
        if path == "runners/hpc":
            return self.send(200, runner())
        if path in EMPTY_LISTS:
            return self.send(200, [])
        if path == "tasks/page":
            return self.send(200, {"items": [], "nextCursor": None})
        if path == "schedules":
            return self.send(200, {"schedules": schedules(), "runs": [], "waitingTasks": waiting_tasks()})
        if path == "schedules/drafts":
            return self.send(200, {"drafts": []})
        if path == "schedules/s-guard":
            return self.send(200, guard_detail())
        if len(parts) == 3 and parts[1] == "schedules":
            found = [s for s in schedules() if s["id"] == parts[2]]
            if found:
                return self.send(200, {"schedule": found[0], "recentRuns": [], "findings": [], "history": [],
                                       "pendingCards": []})
        if len(parts) == 4 and parts[1] == "schedules" and parts[3] == "runs":
            return self.send(200, {"runs": [guard_run()] if parts[2] == "s-guard" else []})
        if len(parts) == 3 and parts[1] == "conditions" and parts[2] in conditions():
            return self.send(200, conditions()[parts[2]])
        if path == "owner-requests":
            return self.send(200, {"requests": owner_requests()})
        if path == "tasks/t-osd":
            return self.send(200, task_osd())
        if path == "sessions":
            view = query.get("view", ["open"])[0]
            rows = [session_row(sid, s) for sid, s in STATE["sessions"].items() if not s.get("run")]
            return self.send(200, rows if view == "open" else [])
        if len(parts) >= 3 and parts[1] == "sessions":
            sid = parts[2]
            s = STATE["sessions"].get(sid)
            if s is None:
                return self.send(404, {"message": "not in the probe"})
            rest = parts[3:]
            if rest == []:
                return self.send(200, session_row(sid, s))
            if rest == ["events"]:
                return self.stream(s, int(query.get("sinceSeq", ["0"])[0] or 0))
            if rest == ["events", "page"]:
                return self.send(200, {"events": s["events"], "hasMore": False, "before": None, "after": None})
            if rest == ["turns"]:
                return self.send(200, [])
            if rest == ["approvals"]:
                return self.send(200, approvals(sid))
            if rest == ["schedule-cards"]:
                return self.send(200, schedule_cards(sid))
        return self.send(404, {"statusCode": 404, "message": "not in the probe"})

    def keepalive(self):
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

    def stream(self, s, sent):
        """Replay what follows `sinceSeq` (SSE `data:` frames), then keep the stream alive."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        last_ping = time.time()
        try:
            while True:
                for e in s["events"]:
                    if e["seq"] > sent:
                        self.wfile.write(("data: %s\n\n" % json.dumps(e, ensure_ascii=False)).encode())
                        sent = e["seq"]
                if time.time() - last_ping > 10:
                    self.wfile.write(b": ping\n\n")
                    last_ping = time.time()
                self.wfile.flush()
                time.sleep(0.5)
        except (BrokenPipeError, ConnectionResetError):
            return

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        self.body()
        if parts == ["__reset"]:
            STATE.clear()
            STATE.update(fresh_state())
            return self.send(200, {"ok": True})
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not change anything"})

    def do_PATCH(self):
        self.body()
        return self.send(409, {"statusCode": 409, "message": "the probe does not change anything"})

    def do_DELETE(self):
        self.body()
        return self.send(409, {"statusCode": 409, "message": "the probe does not change anything"})


if __name__ == "__main__":
    class LoopbackServer(ThreadingHTTPServer):
        daemon_threads = True

        # No reverse lookup of our own name: on macOS it can raise the local-network prompt.
        def server_bind(self):
            import socketserver
            socketserver.TCPServer.server_bind(self)
            self.server_name, self.server_port = "localhost", self.server_address[1]

    print("stub listening on 127.0.0.1:%d, started %s" % (PORT, STARTED.isoformat()), flush=True)
    LoopbackServer(("127.0.0.1", PORT), Handler).serve_forever()
