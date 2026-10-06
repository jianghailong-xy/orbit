#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API the iPhone app reads to draw the
# drawer's Wiki row, the Wiki's head, Activity and Review (task I1, mocks 31 ② ④ ⑤). The data follows
# the mocks' — the orbit space as it stood on 2026-10-06 (11,457 entries, maintained 3h ago, 276 to
# catch up, documents being written 5 of 35, one proposal) — and, in the three-space mode, wikova's
# two proposals and its plan draft waiting, and wikids with nothing. Workspace a1 (orbit-develop) is
# bound to orbit, a2 (orbit-macos) to wikova. Read-only: every write is refused; every request is
# logged; anything not served is a 404.
#
#   stub.py PORT LOG MODE       MODE is "one" (today's single space) or "three".
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
MODE = sys.argv[3] if len(sys.argv) > 3 else "one"


def ago(minutes):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def day(month, d, hour=10):
    return "2026-%02d-%02dT%02d:00:00.000Z" % (month, d, hour)


CLAUDE_CATALOG = [{"value": "claude-opus-5-5", "label": "Opus 5.5", "contextWindow": 1000000,
                   "reasoningLevels": ["low", "medium", "high", "max"]}]


def runner(rid, name):
    return {"id": rid, "name": name, "displayName": name, "online": True, "status": "ONLINE",
            "version": "0.1.215", "maxConcurrent": 4, "lastHeartbeatAt": ago(0), "capabilities": [],
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}],
            "modelCatalog": {"claude": CLAUDE_CATALOG}, "runtimeDefaultModels": {"claude": "claude-opus-5-5"}}


def agent(aid, name, rid):
    return {"id": aid, "name": name, "provider": "claude", "lastProvider": "claude", "runnerId": rid,
            "enabled": True, "enableWorktree": False, "effort": "", "workDir": "/srv/" + name,
            "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}


RUNNERS = [runner("r1", "hpc"), runner("r2", "mac-mini")]
AGENTS = [agent("a1", "orbit-develop", "r1"), agent("a2", "orbit-macos", "r2")]


def session(sid, title, minutes, text, aid="a1"):
    name = {"a1": "orbit-develop", "a2": "orbit-macos"}[aid]
    return {"id": sid, "title": title, "status": "AWAITING_INPUT", "runStatus": "AWAITING_INPUT",
            "runState": "AWAITING_INPUT", "lifecycleState": "OPEN", "agentId": aid,
            "agent": {"id": aid, "name": name}, "assignedRunnerId": "r1", "provider": "claude",
            "model": "claude-opus-5-5", "effort": "high", "permissionMode": "default", "taskId": None,
            "projectId": None, "createdAt": ago(minutes + 30), "updatedAt": ago(minutes),
            "lastTurnAt": ago(minutes), "lastAssistantText": text, "pendingApprovals": 0, "tags": [],
            "folderId": None, "source": "USER"}


SESSIONS = [
    session("S1", "Activity page on iOS", 4, "The drawer's number and the badge agree."),
    session("S2", "Review the plan draft", 30, "Five documents are written."),
]

# ── the Wiki ─────────────────────────────────────────────────────────────────────────────────────

ORBIT, WIKOVA, WIKIDS = "34WSpaceOrbitProbe0001", "34WSpaceWikovaProbe001", "34WSpaceWikidsProbe001"


def space(sid, repo, pending, plan_waiting, workspaces, docs):
    slug = "github-com-" + repo.replace("github.com/", "").replace("/", "-")
    return {"id": sid, "publicId": sid, "slug": slug, "title": slug, "repoUrlNorm": repo, "rootCommitSha": None,
            "settings": None, "createdAt": day(9, 20), "updatedAt": ago(180), "pendingOps": pending,
            "planWaiting": plan_waiting, "workspaceIds": workspaces, "docs": docs}


if MODE == "three":
    SPACES = [space(ORBIT, "github.com/jianghailong-xy/orbit", 1, 0, ["a1"], {"written": 5, "total": 35}),
              space(WIKOVA, "github.com/jianghailong-xy/wikova", 2, 1, ["a2"], {"written": 12, "total": 12}),
              space(WIKIDS, "github.com/jianghailong-xy/wikids", 0, 0, [], None)]
else:
    SPACES = [space(ORBIT, "github.com/jianghailong-xy/orbit", 1, 0, ["a1"], {"written": 5, "total": 35})]
BY_ID = {s["id"]: s for s in SPACES}

USAGE = {"days": 7, "sessionsPushed": 692, "searches": 0, "gets": 0, "entries": [
    {"entryId": "34WEntryWakeupLost0001", "title": "ScheduleWakeup is lost on engine recycle because it lives in the engine",
     "total": 1753, "pushed": 1753, "searched": 0, "fetched": 0},
    {"entryId": "34WEntryReleaseSh00001", "title": "Cut a release with release.sh from the main checkout",
     "total": 1691, "pushed": 1691, "searched": 0, "fetched": 0},
    {"entryId": "34WEntryBigIntJson0001", "title": "缺 BigInt.prototype.toJSON 使 PATCH 返回 500",
     "total": 1469, "pushed": 1469, "searched": 0, "fetched": 0}]}


def entry(eid, kind, title, summary, valid_from, sid=ORBIT):
    return {"id": eid, "publicId": eid, "spaceId": sid, "kind": kind, "status": "active", "trust": "confirmed",
            "currentRevision": 1, "title": title, "summary": summary, "fields": {}, "topics": [], "aliases": [],
            "anchors": [], "anchorState": None, "tainted": False, "challenged": False, "unsupported": False,
            "pinned": False, "supersedesId": None, "supersededById": None, "validFrom": valid_from, "validTo": None,
            "recordedAt": valid_from, "retiredAt": None}


DECISIONS = [
    entry("34WDecisionAutoPush01", "decision", "移除 wiki 自动推送功能而非调整展示",
          "wiki auto-attach 整个功能被删除，不再在会话首轮把 <orbit_wiki> 推送给 agent。", day(10, 6, 9)),
    entry("34WDecisionStopBg0001", "decision", "「有后台工作也给 Stop」是 owner 定的，不是漏判",
          "在 AWAITING_INPUT 但仍有未结束后台工作时也显示 Stop。", day(10, 6, 7)),
    entry("34WDecisionProjSess01", "decision", "项目会话页列全部会话，行操作按各自生命周期",
          "owner 10-04 定：不分 Open/Completed 视图，合并去重。", day(10, 5, 9)),
    entry("34WDecisionEscalate01", "decision", "升级按真实进展：在途不升级，泛聊天不续时钟",
          "escalatesAt 取最晚进展（投递轮被答、挂修复任务、会话末轮）。", day(10, 5, 7)),
]

# Four maintenance runs three hours ago — after the stamp the probe app leaves (four hours ago), so
# they are new — and an owner's amend two days before, which is not.
RUNS = [("34WRunProbe0000000001", 5, 5, 0, 0), ("34WRunProbe0000000002", 1, 1, 0, 0),
        ("34WRunProbe0000000003", 1, 0, 1, 0), ("34WRunProbe0000000004", 13, 9, 4, 1)]


def timeline(sid):
    if sid != ORBIT:
        return {"items": []}
    items = []
    for n, (cid, applied, _auto, _unrev, _rej) in enumerate(RUNS):
        items.append({"opId": "%s-op" % cid, "op": "add", "decision": "auto_applied", "origin": "maintenance",
                      "at": ago(180 + n), "entryId": "34WEntryRun%d" % n, "title": "Run %d entry" % n, "kind": "pitfall",
                      "status": "active", "trust": "auto", "supersededById": None, "supersededByTitle": None,
                      "reason": None, "appliedByMode": "auto", "changesetId": cid, "changesetAppliedByMode": "auto"})
    items.append({"opId": "34WOpOwnerAmend000001", "op": "amend", "decision": "auto_applied", "origin": "owner",
                  "at": ago(60 * 48), "entryId": "34WEntryReleaseSh00001",
                  "title": "Cut a release with release.sh from the main checkout", "kind": "recipe",
                  "status": "active", "trust": "confirmed", "supersededById": None, "supersededByTitle": None,
                  "reason": None})
    return {"items": items}


def run_view(cid):
    for n, (rid, applied, auto, unrev, rej) in enumerate(RUNS):
        if rid == cid:
            return {"id": rid, "publicId": rid, "spaceId": ORBIT, "origin": "maintenance", "sessionId": None,
                    "rationale": "Wiki maintenance", "createdAt": ago(180 + n), "ops": [], "appliedByMode": "auto",
                    "entries": [], "counts": {"applied": applied, "auto": auto, "unreviewed": unrev,
                                              "rejectedByCheck": rej, "toReview": 0}, "revertible": False}
    return None


def health(sid):
    entries = {ORBIT: 11457, WIKOVA: 412, WIKIDS: 0}.get(sid, 0)
    return {"spaceId": sid, "entries": entries, "maintenance": {
        "look": "ok", "enabled": True, "lastOkAt": ago(180), "lastRunAt": ago(180), "consecutiveFailures": 0,
        "backlog": 276, "oldestPendingAt": ago(170), "lagSeconds": 600, "dailyLimitReached": False, "held": None,
        "running": None, "lastRun": {"sessionId": "34WMaintSession000001", "outcome": "succeeded", "endedAt": ago(180)}}}


def plan(sid):
    if sid == ORBIT:
        # v13 confirmed, its documents being written: the blue `Writing documents · 5 of 35`.
        return {"spaceId": sid, "confirmed": {"id": "34WPlanV13", "version": 13, "status": "confirmed"}, "draft": None,
                "proposals": [], "job": {"id": "34WJobBuild0001", "spaceId": sid, "kind": "build", "state": "running",
                                         "requestedAt": ago(200), "startedAt": ago(190),
                                         "progress": {"docs": {"done": 5, "total": 35}, "current": None}}}
    if sid == WIKOVA:
        # A draft waiting to be confirmed: the one thing its plan waits on the owner for (planWaiting 1).
        return {"spaceId": sid, "confirmed": None, "draft": {"id": "34WPlanWikovaV1", "version": 1, "status": "draft"},
                "proposals": [], "job": None}
    return {"spaceId": sid, "confirmed": None, "draft": None, "proposals": [], "job": None}


def op(oid, cid, seq, title, kind):
    return {"id": oid, "changesetId": cid, "seq": seq, "op": "add", "entryId": None, "baseRevision": None,
            "tainted": False, "decision": "pending", "decisionReason": None, "decisionNote": None,
            "resultEntryId": None, "resultRevision": None, "decidedAt": None, "similar": [],
            "payload": {"op": "add", "entry": {"kind": kind, "title": title, "summary": title, "fields": {}}}}


def review():
    queue = [{"id": "34WCsOrbitProbe000001", "spaceId": ORBIT, "origin": "agent", "sessionId": "34WProposerSessionA01",
              "toolCallId": None, "rationale": "Orbit wiki review", "status": "pending", "createdAt": ago(120),
              "decidedAt": None, "expiresAt": ago(-60 * 24 * 13),
              "ops": [op("34WOpOrbitProbe000001", "34WCsOrbitProbe000001", 0,
                         "Wiki drawer number counts what waits on the owner", "convention")]}]
    if MODE == "three":
        queue.append({"id": "34WCsWikovaProbe00001", "spaceId": WIKOVA, "origin": "agent",
                      "sessionId": "34WProposerSessionB01", "toolCallId": None, "rationale": "wikova review",
                      "status": "pending", "createdAt": ago(90), "decidedAt": None, "expiresAt": ago(-60 * 24 * 13),
                      "ops": [op("34WOpWikovaProbe00001", "34WCsWikovaProbe00001", 0, "Search answers in the reader's language", "convention"),
                              op("34WOpWikovaProbe00002", "34WCsWikovaProbe00001", 1, "An index rebuild never blocks a read", "pitfall")]})
    return queue


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        with open(LOG, "a") as f:
            f.write("%s %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

    def send(self, status, body=None):
        data = b"" if body is None else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        parts = [p for p in url.path.split("/") if p]
        if parts == ["api", "agents"]:
            return self.send(200, AGENTS)
        if len(parts) == 3 and parts[:2] == ["api", "agents"]:
            found = [a for a in AGENTS if a["id"] == parts[2]]
            return self.send(200, found[0]) if found else self.send(404, {"error": "no agent"})
        if parts == ["api", "runners"]:
            return self.send(200, RUNNERS)
        if parts in (["api", "providers"], ["api", "providers", "mine"], ["api", "providers", "pools"],
                     ["api", "providers", "shared-pools"], ["api", "session-tags"], ["api", "session-folders"],
                     ["api", "task-lists"], ["api", "watches"], ["api", "share-links"], ["api", "projects"],
                     ["api", "projects", "sidebar"]):
            return self.send(200, [])
        if parts == ["api", "sessions"]:
            return self.send(200, SESSIONS if query.get("view", ["open"])[0] == "open" else [])
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "events":
            return self.stream()
        if parts[:2] == ["api", "wiki"]:
            return self.wiki(parts[2:], query)
        return self.send(404, {"error": "not in the probe"})

    def wiki(self, rest, query):
        if rest == ["spaces"]:
            return self.send(200, SPACES)
        if rest == ["review"]:
            return self.send(200, review())
        if len(rest) == 2 and rest[0] == "changesets":
            view = run_view(rest[1])
            return self.send(200, view) if view else self.send(404, {"error": "no run"})
        if len(rest) >= 2 and rest[0] == "spaces" and rest[1] in BY_ID:
            sid, tail = rest[1], rest[2:]
            if tail == []:
                return self.send(200, dict(BY_ID[sid], usage=USAGE if sid == ORBIT else None))
            if tail == ["entries"]:
                kind = query.get("kind", [None])[0]
                return self.send(200, DECISIONS if kind == "decision" and sid == ORBIT else [])
            if tail == ["timeline"]:
                return self.send(200, timeline(sid))
            if tail == ["health"]:
                return self.send(200, health(sid))
            if tail == ["plan"]:
                return self.send(200, plan(sid))
            if tail == ["plan", "versions"]:
                return self.send(200, {"spaceId": sid, "versions": []})
            if tail == ["docs"]:
                return self.send(200, {"spaceId": sid, "plan": None, "docs": None, "categories": []})
        return self.send(404, {"error": "not in the probe"})

    def stream(self):
        """An event stream with nothing to say: keepalives inside the clients' 45 s watchdog."""
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

    def refuse(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            self.rfile.read(n)
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

    do_POST = refuse
    do_PATCH = refuse
    do_PUT = refuse
    do_DELETE = refuse


if __name__ == "__main__":
    class LoopbackServer(ThreadingHTTPServer):
        # HTTPServer.server_bind resolves its own name (socket.getfqdn), a reverse lookup that on
        # macOS raises the "find devices on local networks" prompt over the app being photographed.
        def server_bind(self):
            import socketserver
            socketserver.TCPServer.server_bind(self)
            self.server_name, self.server_port = "localhost", self.server_address[1]

    server = LoopbackServer(("127.0.0.1", PORT), Handler)
    print("stub (%s) listening on 127.0.0.1:%d (python %s)" % (MODE, PORT, sys.version.split()[0]), flush=True)
    server.serve_forever()
