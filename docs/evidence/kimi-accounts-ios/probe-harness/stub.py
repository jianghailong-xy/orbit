#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API the iPhone app reads for Kimi Code
# accounts (docs/mocks/kimi-accounts/02-ios), on one machine, HPC, whose engines keep accounts:
#
#   Claude Code  alex@example.com (Default), alex.team@example.com, alex.side@example.com
#   Codex        Default (its 5 hours spent), Pro
#   Kimi Code    Default on kimi.ai (~/.kimi-code), Work on kimi.com (~/.orbit/kimi-accounts/5c2e91a0)
#   Antigravity  Default, Work (its 5 hours nearly spent)
#
# POST /__set {"kimi": "two" | "one" | "old" | "workout"} picks what the runner says of Kimi: both accounts
# (the default), Default alone, a runner too old to keep Kimi accounts (no kimi-account-* capability, no
# accounts listed, no Kimi quota), or both with Work signed out. The sign-in relay is the runner's, played here: POST .../login starts
# it (pending for 2 s, then Kimi's device code on the site the start names); POST /__set
# {"approve": true} approves it — an account being added then joins the list under its name and site.
# Session S1 is a Kimi session on Work: PATCH /api/sessions/S1/account moves it (and pins it), and
# POST .../turns adds the follow-up and a reply. Every request is logged with its body; anything not
# served is a 404. All data is made up.
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
WORK = "5c2e91a0"


def at(minutes):
    t = datetime.now(timezone.utc) + timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def fresh_state():
    return {"kimi": "two", "login": None, "approved": False, "added": None,
            "s1_account": WORK, "s1_pinned": True, "continued": False, "renamed": {}}


STATE = fresh_state()

AGENTS = [{"id": "a1", "name": "orbit-develop", "provider": "kimi", "lastProvider": "kimi", "runnerId": "hpc",
           "enabled": True, "enableWorktree": False, "effort": "", "workDir": "/root/orbit",
           "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}]

KIMI_MODELS = [{"value": "kimi-k2.7-coding", "label": "K2.7 Coding"},
               {"value": "kimi-k3", "label": "K3", "reasoningLevels": ["low", "high", "max"],
                "defaultReasoningLevel": "high"}]
CLAUDE_MODELS = [{"value": "claude-opus-5-5", "label": "Opus 5.5", "reasoningLevels": ["low", "medium", "high", "max"]}]


def window(utilization, resets_in, minutes=None):
    w = {"utilization": utilization, "resetsAt": at(resets_in)}
    if minutes:
        w["windowDurationMins"] = minutes
    return w


def kimi_usage(five, five_in, week, week_in, month, month_in, code):
    return {"provider": "kimi", "fetchedAt": at(-1), "fiveHour": window(five, five_in),
            "sevenDay": window(week, week_in), "month": window(month, month_in),
            "monthCode": window(code, month_in)}


# The board's numbers: Default 5h 12%, Weekly 34%, Monthly 8%; Work 5h 91%, Weekly 61%, Monthly 22%.
DEFAULT_KIMI = kimi_usage(12, 130, 34, 4 * 24 * 60 + 930, 8, 23 * 24 * 60 + 870, 5)
WORK_KIMI = kimi_usage(91, 45, 61, 24 * 60 + 1230, 22, 20 * 24 * 60 + 1302, 15)


def kimi_accounts():
    mode = STATE["kimi"]
    if mode == "old":
        return None
    accounts = [{"id": "default", "auth": "yes", "home": "/root/.kimi-code", "kimiRegion": "global"}]
    if mode in ("two", "workout"):
        accounts.append({"id": WORK, "name": "Work", "auth": "no" if mode == "workout" else "yes",
                         "home": "/root/.orbit/kimi-accounts/" + WORK, "kimiRegion": "mainland-cn"})
    elif STATE["added"]:
        accounts.append(STATE["added"])
    for account in accounts:
        if account["id"] in STATE["renamed"]:
            account["name"] = STATE["renamed"][account["id"]]
    return accounts


def kimi_plan_usage():
    if STATE["kimi"] == "old":
        return None
    usage = dict(DEFAULT_KIMI)
    if STATE["kimi"] == "two" or STATE["added"]:
        usage["accounts"] = {WORK: WORK_KIMI}
    return usage


def bucket(bid, left, resets_in):
    return {"id": bid, "window": "5h" if bid.endswith("5h") else "weekly", "remainingFraction": left,
            "resetTime": at(resets_in)}


def engines():
    kimi = {"engine": "kimi", "installed": True, "version": "2.1.1", "auth": "yes", "kimiRegion": "global",
            "update": {"status": "ok", "at": at(-29), "okAt": at(-29)}}
    accounts = kimi_accounts()
    if accounts is not None:
        kimi["accounts"] = accounts
    return [
        {"engine": "claude", "installed": True, "version": "2.1.294 (Claude Code)", "auth": "yes",
         "update": {"status": "ok", "at": at(-4), "okAt": at(-4)},
         "accounts": [
             {"id": "default", "name": "alex@example.com", "auth": "yes", "home": "/root/.claude"},
             {"id": "a1b2c3d4", "name": "alex.team@example.com", "auth": "yes",
              "home": "/root/.orbit/claude-accounts/a1b2c3d4"},
             {"id": "e5f6a7b8", "name": "alex.side@example.com", "auth": "yes",
              "home": "/root/.orbit/claude-accounts/e5f6a7b8"}]},
        {"engine": "codex", "installed": True, "version": "codex-cli 0.161.0", "auth": "yes",
         "accounts": [
             {"id": "default", "auth": "yes", "home": "/root/.codex", "codexHome": "/root/.codex"},
             {"id": "1fda3f43", "name": "Pro", "auth": "yes", "home": "/root/.orbit/codex-accounts/1fda3f43",
              "codexHome": "/root/.orbit/codex-accounts/1fda3f43"}]},
        kimi,
        {"engine": "opencode", "installed": True, "version": "1.14.2", "auth": "unknown"},
        {"engine": "antigravity", "installed": True, "version": "1.3.1", "auth": "yes", "authSource": "google",
         "accounts": [
             {"id": "default", "auth": "yes", "home": "/root/.orbit/antigravity/google"},
             {"id": "9f8e7d6c", "name": "Work", "auth": "yes", "home": "/root/.orbit/antigravity-accounts/9f8e7d6c"}],
         "planUsage": {"provider": "antigravity", "fetchedAt": at(-1),
                       "buckets": [bucket("gemini-weekly", 1, 5 * 24 * 60), bucket("gemini-5h", 1, 200),
                                   bucket("3p-weekly", 0.98, 3 * 24 * 60), bucket("3p-5h", 1, 200)],
                       "accounts": {"9f8e7d6c": {"provider": "antigravity", "fetchedAt": at(-1), "buckets": [
                           bucket("gemini-weekly", 0.61, 2 * 24 * 60), bucket("gemini-5h", 0.04, 40),
                           bucket("3p-weekly", 1, 2 * 24 * 60), bucket("3p-5h", 1, 40)]}}}},
    ]


def plan_usage():
    usage = {
        # Claude: alex.team's week ends first, so a new session starts there.
        "claude": {"provider": "claude", "fetchedAt": at(-1), "fiveHour": window(6, 200, 300),
                   "sevenDay": window(34, 4 * 24 * 60),
                   "accounts": {"a1b2c3d4": {"provider": "claude", "fiveHour": window(19, 200, 300),
                                             "sevenDay": window(70, 18 * 60)},
                                "e5f6a7b8": {"provider": "claude", "fiveHour": window(2, 250, 300),
                                             "sevenDay": window(10, 5 * 24 * 60)}}},
        # Codex: Default's 5 hours are spent, so Pro.
        "codex": {"provider": "codex", "fetchedAt": at(-1), "primary": window(100, 150, 300),
                  "secondary": window(18, 3 * 24 * 60, 10080),
                  "accounts": {"1fda3f43": {"provider": "codex", "primary": window(40, 5 * 24 * 60, 10080)}}},
    }
    kimi = kimi_plan_usage()
    if kimi:
        usage["kimi"] = kimi
    return usage


def capabilities():
    caps = ["claude-account-move/v1", "codex-account-move/v1", "antigravity-account-login/v1",
            "antigravity-account-remove/v1", "kimi-login-region/v1"]
    if STATE["kimi"] != "old":
        caps += ["kimi-account-login/v1", "kimi-account-remove/v1", "kimi-account-move/v1"]
    return caps


def runner():
    return {
        "id": "hpc", "name": "HPC", "displayName": "HPC", "hostname": "workstation", "online": True,
        "status": "ONLINE", "version": "0.1.232", "maxConcurrent": 8, "activeSessions": 1,
        # Stamped now: a once-stamped heartbeat would grey the machine out within the run.
        "lastHeartbeatAt": at(-0.2), "planUsage": plan_usage(), "capabilities": capabilities(),
        "engines": engines(),
        "antigravity": {"supported": True, "installed": True, "version": "1.3.1", "envKeyAvailable": False,
                        "authSource": "google", "googleLogin": "available"},
        "modelCatalog": {"kimi": KIMI_MODELS, "claude": CLAUDE_MODELS},
        "runtimeDefaultModels": {"kimi": "kimi-k3", "claude": "claude-opus-5-5"},
    }


def login_state():
    login = STATE["login"]
    if not login:
        return {"status": None, "engine": None, "url": None, "userCode": None, "message": None, "account": None}
    base = {"engine": login["engine"], "account": login.get("account"), "message": None, "url": None,
            "userCode": None}
    if STATE["approved"]:
        return {**base, "status": "done"}
    if time.time() - login["t0"] < 2:
        return {**base, "status": "pending"}
    site = "kimi.ai" if login.get("region") == "global" else "kimi.com"
    return {**base, "status": "awaiting_approval", "userCode": "7K06-QP86",
            "url": "https://www.%s/code/authorize_device?user_code=7K06-QP86" % site}


def approve():
    login = STATE["login"]
    STATE["approved"] = True
    if login and login.get("accountName"):
        STATE["added"] = {"id": WORK, "name": login["accountName"], "auth": "yes",
                          "home": "/root/.orbit/kimi-accounts/" + WORK,
                          "kimiRegion": login.get("region") or "mainland-cn"}


def ev(seq, typ, turn, payload, minutes=0):
    return {"seq": seq, "type": typ, "ts": at(-minutes), "turnId": turn, "payload": payload}


def s1_events():
    out = [
        ev(1, "user", "t1", {"text": "Kimi 的额度从哪儿读？"}, 9),
        ev(2, "assistant", "t1", {"text": "账号目录 config.toml 里 `managed:kimi-code` 的 base_url 加 `/usages`，带上这个账号的 access token 就行。",
                                  "messageId": "m1"}, 9),
        ev(3, "result", "t1", {"subtype": "success", "result": "done"}, 9),
        ev(4, "user", "t2", {"text": "把 /usages 的返回整理成表，再接着写解析。"}, 6),
        ev(5, "assistant", "t2", {"text": "四个窗口都是 `{used_ratio, reset_time}`：`limit_5h`、`limit_7d`、`limit_month_total`，还有 `limit_month_code`——月度里 Kimi Code 用掉的那段。\n\n表写在 notes/usages.md，下一步写 parseUsages()。",
                                  "messageId": "m2"}, 6),
        ev(6, "result", "t2", {"subtype": "success", "result": "done"}, 6),
    ]
    if STATE["continued"]:
        out += [
            ev(7, "user", "t3", {"text": "换到 Default 了，接着写 parseUsages()。"}, 0),
            ev(8, "assistant", "t3", {"text": "好，接着上面那张表：先把 `used_ratio × 100` 换成百分比，`reset_time` 原样留作 resetsAt……",
                                      "messageId": "m3"}, 0),
            ev(9, "result", "t3", {"subtype": "success", "result": "done"}, 0),
        ]
    return out


def s1():
    return {"id": "S1", "title": "Kimi 额度：按账号读取与上报", "status": "AWAITING_INPUT",
            "runStatus": "AWAITING_INPUT", "runState": "AWAITING_INPUT", "lifecycleState": "OPEN",
            "agentId": "a1", "agent": {"id": "a1", "name": "orbit-develop"}, "assignedRunnerId": "hpc",
            "provider": "kimi", "model": "kimi-k3", "effort": "high", "permissionMode": "default",
            "kimiAccount": STATE["s1_account"], "kimiAccountPinned": STATE["s1_pinned"],
            "taskId": None, "projectId": None, "createdAt": at(-10), "updatedAt": at(0), "lastTurnAt": at(0),
            "lastAssistantText": "表写在 notes/usages.md，下一步写 parseUsages()。", "pendingApprovals": 0,
            "tags": [], "folderId": None, "source": "USER"}


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

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        text = raw.decode("utf-8", "replace")
        with open(LOG, "a") as f:
            f.write("    %s %s body: %s\n" % (self.command, urlparse(self.path).path, text))
        try:
            return json.loads(text) if text else {}
        except ValueError:
            return {}

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        parts = [p for p in url.path.split("/") if p]
        if parts == ["api", "agents"]:
            return self.send(200, AGENTS)
        if parts == ["api", "agents", "a1"]:
            return self.send(200, AGENTS[0])
        if parts == ["api", "runners"]:
            return self.send(200, [runner()])
        if parts == ["api", "runners", "hpc"]:
            return self.send(200, runner())
        if parts == ["api", "runners", "hpc", "login"]:
            return self.send(200, login_state())
        if parts in (["api", "providers"], ["api", "providers", "mine"], ["api", "providers", "pools"],
                     ["api", "providers", "shared-pools"], ["api", "session-tags"], ["api", "session-folders"],
                     ["api", "task-lists"], ["api", "watches"], ["api", "share-links"], ["api", "projects"]):
            return self.send(200, [])
        if parts == ["api", "sessions"]:
            view = query.get("view", ["open"])[0]
            return self.send(200, [s1()] if view == "open" else [])
        if parts == ["api", "sessions", "S1", "events"]:
            return self.stream(int(query.get("sinceSeq", ["0"])[0] or 0))
        if parts == ["api", "sessions", "S1"]:
            return self.send(200, s1())
        if parts == ["api", "sessions", "S1", "events", "page"]:
            return self.send(200, {"events": s1_events(), "hasMore": False, "before": None, "after": None})
        if parts in (["api", "sessions", "S1", "approvals"], ["api", "sessions", "S1", "turns"]):
            return self.send(200, [])
        return self.send(404, {"error": "not in the probe"})

    def stream(self, sent):
        """Replay what follows `sinceSeq`, then push each event the follow-up adds (SSE `data:` frames,
        the server's framing), with a keepalive inside the clients' 45 s watchdog."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        last_ping = time.time()
        try:
            while True:
                for e in s1_events():
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
        body = self.body()
        if parts == ["__reset"]:
            STATE.clear()
            STATE.update(fresh_state())
            return self.send(200, {"ok": True})
        if parts == ["__set"]:
            if "kimi" in body:
                STATE["kimi"] = body["kimi"]
            if body.get("approve"):
                approve()
            return self.send(200, {"kimi": STATE["kimi"], "approved": STATE["approved"]})
        if parts == ["api", "runners", "hpc", "login"]:
            STATE["login"] = {"engine": body.get("engine"), "account": body.get("account"),
                              "accountName": body.get("accountName"), "region": body.get("region"),
                              "t0": time.time()}
            STATE["approved"] = False
            return self.send(201, login_state())
        if parts == ["api", "sessions", "S1", "turns"]:
            STATE["continued"] = True
            return self.send(201, {"turnId": "t3", "seq": 7, "status": "PENDING", "kind": "message"})
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not change anything"})

    def do_PATCH(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        body = self.body()
        if parts == ["api", "sessions", "S1", "account"]:
            account = body.get("account")
            STATE["s1_account"] = None if account == "automatic" else account
            STATE["s1_pinned"] = account != "automatic"
            return self.send(200, s1())
        if len(parts) == 6 and parts[:3] == ["api", "runners", "hpc"] and parts[3] == "accounts":
            STATE["renamed"][parts[5]] = body.get("name")
            return self.send(200, {"id": parts[5], "name": body.get("name"), "auth": "yes"})
        return self.send(404, {"error": "not in the probe"})

    def do_DELETE(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if parts == ["api", "runners", "hpc", "login"]:
            STATE["login"] = None
            return self.send(200, login_state())
        return self.send(404, {"error": "not in the probe"})


if __name__ == "__main__":
    class LoopbackServer(ThreadingHTTPServer):
        daemon_threads = True

        # HTTPServer.server_bind resolves its own name (socket.getfqdn), a reverse lookup that on
        # macOS can raise the "find devices on local networks" prompt.
        def server_bind(self):
            import socketserver
            socketserver.TCPServer.server_bind(self)
            self.server_name, self.server_port = "localhost", self.server_address[1]

    server = LoopbackServer(("127.0.0.1", PORT), Handler)
    print("stub listening on 127.0.0.1:%d (python %s)" % (PORT, sys.version.split()[0]), flush=True)
    server.serve_forever()
