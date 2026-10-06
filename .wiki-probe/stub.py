#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API the iPhone and iPad apps read to draw the
# Wiki's home, its directory column, Activity and Review (task I2, mocks 30 ③, 31 ① ③ ⑥ ⑦, 32). The data follows
# the mocks', taken from the orbit space as it stood on 2026-10-06: plan v13 confirmed, 35 documents of which 5
# are written (1.1, 1.2, 2.1, 3.1, 3.2 — mock 30's leads), the categories and titles of mock 33; 11,457 entries,
# maintained 3h ago, one proposal. 3.1 and 3.2 were written after the reader last looked (the probe app leaves
# the stamp four hours back), the others before. In the three-space mode orbit carries the six principles of
# mock 31 ③ (orbit has none live; the mock's own note says they are illustrative), wikova two proposals and a
# plan draft waiting, and wikids nothing at all, maintenance not set up (mock 31 ⑥). In the slow mode the
# home's own reads (documents, articles, principles) answer after SLOW seconds (mock 31 ⑦). Workspace a1
# (orbit-develop) is bound to orbit, a2 (orbit-macos) to wikova. Read-only: every write is refused; every
# request is logged; anything not served is a 404.
#
#   stub.py PORT LOG MODE       MODE is "one", "three" or "slow".
import copy
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
MODE = sys.argv[3] if len(sys.argv) > 3 else "one"
SLOW = float(os.environ.get("SLOW", "12"))
HERE = os.path.dirname(os.path.abspath(__file__))


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
    session("S1", "Wiki home on iOS", 4, "The home lists the documents by category."),
    session("S2", "Review the plan draft", 30, "Five documents are written."),
]

# ── the Wiki ─────────────────────────────────────────────────────────────────────────────────────

ORBIT, WIKOVA, WIKIDS = "34WSpaceOrbitProbe0001", "34WSpaceWikovaProbe001", "34WSpaceWikidsProbe001"
MAINTAINED = {"enabled": True, "workspaceId": "a1", "provider": "claude", "dailyRunLimit": 24, "lookbackDays": 0}


def space(sid, repo, pending, plan_waiting, workspaces, docs, maintenance=None):
    slug = "github-com-" + repo.replace("github.com/", "").replace("/", "-")
    settings = {"maintenance": maintenance} if maintenance else None
    return {"id": sid, "publicId": sid, "slug": slug, "title": slug, "repoUrlNorm": repo, "rootCommitSha": None,
            "settings": settings, "createdAt": day(9, 20), "updatedAt": ago(180), "pendingOps": pending,
            "planWaiting": plan_waiting, "workspaceIds": workspaces, "docs": docs}


ORBIT_ROW = space(ORBIT, "github.com/jianghailong-xy/orbit", 1, 0, ["a1"], {"written": 5, "total": 35}, MAINTAINED)
if MODE == "three":
    SPACES = [ORBIT_ROW,
              space(WIKOVA, "github.com/jianghailong-xy/wikova", 2, 1, ["a2"], {"written": 12, "total": 12}, MAINTAINED),
              space(WIKIDS, "github.com/jianghailong-xy/wikids", 0, 0, [], None)]
else:
    SPACES = [ORBIT_ROW]
BY_ID = {s["id"]: s for s in SPACES}

# The confirmed plan's categories and documents (mock 33's list, mock 29's plan): number, title, written.
CATEGORIES = [
    ("overview", "产品概览与架构", [("product", "产品定位与核心能力"), ("architecture", "系统架构与数据流"),
                                   ("self-host", "自部署与首次运行")]),
    ("tasks", "任务与项目", [("task-lifecycle", "任务生命周期与依赖"), ("project-start", "项目启动与协调"),
                            ("completion", "完成判据与验收"), ("integration-line", "项目集成线与落地")]),
    ("sessions", "会话与交互", [("session-runtime", "Session 运行与恢复"), ("realtime", "实时流与推送"),
                               ("session-search", "Session 搜索与消息路由")]),
    ("runners", "Runner 与运行时", [("runner-register", "Runner 注册与排障"), ("engines", "引擎接入与 provider 管理"),
                                    ("runner-cli", "Runner CLI 与自动化")]),
    ("watch", "Watch 与后台作业", [("watch-predicates", "Watch 语义与谓词"), ("watch-ops", "Watch 运维与灰度"),
                                  ("background-jobs", "后台作业生命周期")]),
    ("database", "数据库与可靠性", [("db-writes", "数据库写入审计与锁序"), ("backup", "备份与恢复"),
                                  ("db-conflicts", "数据库冲突排障与性能治理")]),
    ("wiki", "Wiki（Orbit 内置知识库）", [("wiki-model", "Wiki 数据模型与写路径"), ("wiki-maintenance", "Wiki 维护作业与文档生成"),
                                       ("wiki-clients", "Wiki 接口与客户端")]),
    ("security", "安全与信任", [("trust", "信任边界与凭据隔离"), ("permissions", "权限模式与审批"), ("share-links", "分享链接")]),
    ("clients", "原生客户端", [("macos", "macOS 客户端架构"), ("ios", "iOS 客户端与推送"), ("client-release", "客户端发版")]),
    ("reference", "配置与运维参考", [("config", "配置参考"), ("runbook", "运维手册")]),
]
# Mock 30's leads (the first two sentences of each written document's first section); 3.1 and 3.2 written
# after the reader last looked, the rest two days before.
WRITTEN = {
    "product": ("Orbit 是自托管的 coding agent 控制台：agent 跑在你自己的机器上，计划、历史和控制都留在一个自托管的地方。", 60 * 48),
    "architecture": ("Orbit 把协调和执行分开：服务器保存意图与历史，注册的 runner 在本来就有仓库、凭据和网络权限的机器上跑 agent 进程。", 60 * 47),
    "task-lifecycle": ("任务是持久的排队工作单元：可以归进清单、依赖别的任务；合格的 runner 原子地领取它，开一个会话，再回报结果。", 60 * 46),
    "session-runtime": ("session 是一个 runner 上、一个 agent runtime 的可恢复多轮会话：用户的回合先存后投，runner 长轮询领取、交给 runtime，再上传归一化事件。", 120),
    "realtime": ("客户端从每个会话的 SSE 流拿转录事件；用户级控制面流把各处的变化推给所有在线的客户端。", 110),
}


def docs_directory(sid):
    if sid != ORBIT:
        return {"spaceId": sid, "plan": None, "docs": None, "categories": []}
    categories = []
    for c, (key, title, docs) in enumerate(CATEGORIES, start=1):
        rows = []
        for n, (slug, doc_title) in enumerate(docs, start=1):
            lead, minutes = WRITTEN.get(slug, (None, None))
            written = lead is not None
            rows.append({"slug": slug, "number": "%d.%d" % (c, n), "title": doc_title, "question": None,
                         "written": written, "status": "ok" if written else None,
                         "updatedAt": ago(minutes) if written else None, "planVersion": 13 if written else None,
                         "lead": lead,
                         "sections": [{"key": "s%d" % k, "number": k, "title": "%s · %d" % (doc_title, k),
                                       "kind": "overview" if k == 1 else "flow", "written": written, "stale": False}
                                      for k in (1, 2, 3)]})
        categories.append({"key": key, "number": c, "title": title, "question": None, "forAgents": False, "docs": rows})
    return {"spaceId": sid, "plan": {"version": 13, "confirmedAt": day(10, 1)}, "docs": {"total": 35, "written": 5},
            "categories": categories}


def doc_read(sid, slug):
    """A written document's page: the shared fixture's document, under this plan's number and title."""
    directory = docs_directory(sid)
    for category in directory["categories"]:
        for row in category["docs"]:
            if row["slug"] == slug and row["written"]:
                with open(os.path.join(HERE, "..", "src", "shared", "src", "wiki-docs.fixture.json")) as f:
                    doc = copy.deepcopy(json.load(f)["docs"]["doc"]["read"])
                doc.update({"spaceId": sid, "slug": slug, "number": row["number"], "title": row["title"],
                            "updatedAt": row["updatedAt"], "planVersion": 13, "writtenFromPlanVersion": 13,
                            "category": {"key": category["key"], "number": category["number"], "title": category["title"]}})
                return doc
    return None


USAGE = {"days": 7, "sessionsPushed": 692, "searches": 0, "gets": 0, "entries": [
    {"entryId": "34WEntryWakeupLost0001", "title": "ScheduleWakeup is lost on engine recycle because it lives in the engine",
     "total": 1753, "pushed": 1753, "searched": 0, "fetched": 0},
    {"entryId": "34WEntryReleaseSh00001", "title": "Cut a release with release.sh from the main checkout",
     "total": 1691, "pushed": 1691, "searched": 0, "fetched": 0},
    {"entryId": "34WEntryBigIntJson0001", "title": "缺 BigInt.prototype.toJSON 使 PATCH 返回 500",
     "total": 1469, "pushed": 1469, "searched": 0, "fetched": 0}]}


def entry(eid, kind, title, summary, valid_from, sid=ORBIT, trust="confirmed", recorded=None):
    return {"id": eid, "publicId": eid, "spaceId": sid, "kind": kind, "status": "active", "trust": trust,
            "currentRevision": 1, "title": title, "summary": summary, "fields": {}, "topics": [], "aliases": [],
            "anchors": [], "anchorState": None, "tainted": False, "challenged": False, "unsupported": False,
            "pinned": kind == "principle", "supersedesId": None, "supersededById": None, "validFrom": valid_from,
            "validTo": None, "recordedAt": recorded or valid_from, "retiredAt": None}


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
# Mock 31 ③'s six (illustrative there: orbit has none live), the owner's, pinned; recorded in this order, so
# the home lists them so — the day at a row's end is when each became true.
PRINCIPLES = [
    entry("34WPrincipleEvidence1", "principle", "协调会话间要交换可复核一手证据", "转述不算证据。", day(9, 6), trust="owner", recorded=day(9, 20, 1)),
    entry("34WPrincipleFixture01", "principle", "改夹具前先确认它描述活库还是历史快照", "夹具描述的是哪一个库，决定能不能改。", day(9, 19), trust="owner", recorded=day(9, 20, 2)),
    entry("34WPrincipleFlakyRed1", "principle", "修间歇红时不得改生产击杀逻辑去迁就测试", "间歇红先找竞态。", day(9, 5), trust="owner", recorded=day(9, 20, 3)),
    entry("34WPrincipleClockNo01", "principle", "时钟永远不启动 agent 工作", "唤醒由服务器持有。", day(9, 3), trust="owner", recorded=day(9, 20, 4)),
    entry("34WPrincipleDelete001", "principle", "删除就是遗忘", "删掉的东西不再出现在任何读里。", day(9, 2), trust="owner", recorded=day(9, 20, 5)),
    entry("34WPrincipleJudged001", "principle", "完成是被裁定的，不是被宣称的", "DONE 只由判据求值产生。", day(9, 1), trust="owner", recorded=day(9, 20, 6)),
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
            f.write("%s %s\n" % (datetime.now().strftime("%H:%M:%S.%f")[:-3], fmt % args))

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
            # The home's own reads, held back in the slow mode: the head is drawn before any of them answers.
            if MODE == "slow" and (tail in (["docs"], ["articles"]) or (tail == ["entries"] and query.get("kind") == ["principle"])):
                time.sleep(SLOW)
            if tail == []:
                return self.send(200, dict(BY_ID[sid], usage=USAGE if sid == ORBIT else None))
            if tail == ["entries"]:
                kind = query.get("kind", [None])[0]
                if kind == "decision" and sid == ORBIT:
                    return self.send(200, DECISIONS)
                if kind == "principle" and sid == ORBIT and MODE == "three":
                    return self.send(200, list(reversed(PRINCIPLES)))
                return self.send(200, [])
            if tail == ["timeline"]:
                return self.send(200, timeline(sid))
            if tail == ["health"]:
                return self.send(200, health(sid))
            if tail == ["plan"]:
                return self.send(200, plan(sid))
            if tail == ["plan", "versions"]:
                return self.send(200, {"spaceId": sid, "versions": []})
            if tail == ["docs"]:
                return self.send(200, docs_directory(sid))
            if len(tail) == 2 and tail[0] == "docs":
                doc = doc_read(sid, tail[1])
                return self.send(200, doc) if doc else self.send(404, {"error": "not in the plan"})
            if tail == ["articles"]:
                return self.send(200, {"spaceId": sid, "categories": [], "uncategorized": []})
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
