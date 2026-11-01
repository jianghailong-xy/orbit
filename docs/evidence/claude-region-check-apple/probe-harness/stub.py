#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API the iPhone app reads for the Claude region
# check (task 34pVMqwUhJE0RGvrL0ziL, docs/claude-region-check-contract.md, board 03 of
# docs/mocks/claude-region-check). One machine, HPC, whose Claude connection comes out in mainland China:
#
#   runner.region  {verdict blocked, country CN, name "mainland China", viaProxy false, checkedAt 2 min before
#                  the run}, capability claude-region/v1. Claude Code with three accounts (Personal, Work, Team),
#                  Codex (5-hour 12%), Kimi Code and Antigravity CLI, all signed in.
#   S1             "Fix the flaky login test": held — QUEUED with the §9 refusal as its error. Its transcript is
#                  board 03's: the first exchange, the second message, and the runner's own error event for the
#                  refusal (which draws nothing).
#   S2, S3         two ordinary conversations beside it in the list.
#   keys           board 02 C's: DeepSeek, Personal Max and Work (Anthropic), Local vLLM.
#
# The two presses it lets through: POST /api/runners/hpc/region-check (Check again — answered with requestedAt,
# and the next GET /runners carries a check at that time, still blocked) and PATCH /api/sessions/S1/config (the
# provider Use another provider picks). Everything else written is a 409. The app runs in the zone run.sh picks
# (about 13:00 there); every time here is relative to the stub's start. All data is made up.
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
STARTED = datetime.now(timezone.utc)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def ago(minutes):
    return iso(STARTED - timedelta(minutes=minutes))


def now():
    return iso(datetime.now(timezone.utc))


def before_now(minutes):
    """Minutes before this read: the machine's last checks read "2m ago" whenever a test looks."""
    return iso(datetime.now(timezone.utc) - timedelta(minutes=minutes))


REFUSAL = ("CLAUDE_REGION_UNSUPPORTED: HPC’s connection to Anthropic is in mainland China, "
           "where Anthropic doesn’t offer Claude.")

AGENTS = [{"id": "a1", "name": "orbit-develop", "provider": "claude", "lastProvider": "claude", "lastEngine": "claude",
           "runnerId": "hpc", "enabled": True, "enableWorktree": False, "effort": "", "workDir": "/root/orbit",
           "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}]

CLAUDE_MODELS = [{"value": "claude-opus-5-5", "label": "Opus 5.5", "reasoningLevels": ["low", "medium", "high", "max"]}]
CODEX_MODELS = [{"value": "gpt-5.6-sol", "label": "GPT-5.6 Sol"}]

PROVIDERS = [
    {"slug": "deepseek", "label": "DeepSeek", "runtime": "claude", "presetSlug": "deepseek",
     "models": [{"value": "deepseek-v4.1-flash", "label": "DeepSeek V4.1 Flash"}], "defaultModel": "deepseek-v4.1-flash",
     "runsOnOpenCode": True, "engines": ["claude", "opencode", "dsh"]},
    {"slug": "anthropic", "label": "Personal Max", "runtime": "claude", "presetSlug": "anthropic", "models": [],
     "modelsFromRuntime": True, "engines": ["claude"]},
    {"slug": "anthropic-2", "label": "Work", "runtime": "claude", "presetSlug": "anthropic", "models": [],
     "modelsFromRuntime": True, "engines": ["claude"]},
    {"slug": "local-vllm", "label": "Local vLLM", "runtime": "claude", "presetSlug": None,
     "models": [{"value": "qwen3-coder", "label": "Qwen3 Coder"}], "defaultModel": "qwen3-coder",
     "runsOnOpenCode": True, "engines": ["claude", "opencode"]},
]


def fresh_state():
    # checkedAt None: two minutes before each read, until Check again records a check of its own.
    return {"checkedAt": None, "checks": 0, "provider": "claude"}


STATE = fresh_state()


def window(utilization, resets_in_minutes, minutes):
    return {"utilization": utilization, "resetsAt": iso(STARTED + timedelta(minutes=resets_in_minutes)),
            "windowDurationMins": minutes}


def updated():
    return {"status": "ok", "at": before_now(2), "okAt": before_now(2)}


def runner():
    return {
        "id": "hpc", "name": "workstation-gpu", "displayName": "HPC", "hostname": "workstation", "online": True,
        "status": "ONLINE", "version": "0.1.240", "maxConcurrent": 16, "activeSessions": 5,
        # Stamped at each read: a once-stamped heartbeat greys the machine out within the run.
        "lastHeartbeatAt": now(), "enrolledAt": ago(120 * 24 * 60), "runsAsRoot": True,
        "capabilities": ["claude-region/v1", "claude-account-move/v1", "codex-account-move/v1"],
        "region": {"verdict": "blocked", "country": "CN", "regionCode": None, "name": "mainland China",
                   "viaProxy": False, "checkedAt": STATE["checkedAt"] or before_now(2)},
        "antigravity": {"supported": True, "installed": True, "version": "1.3.4", "googleLogin": "available",
                        "authSource": "google", "envKeyAvailable": False},
        "engines": [
            {"engine": "claude", "installed": True, "version": "2.1.302 (Claude Code)", "auth": "yes",
             "update": updated(),
             "accounts": [{"id": "default", "name": "Personal", "home": "/root/.claude", "auth": "yes"},
                          {"id": "3c5e8a10", "name": "Work", "home": "/root/.orbit/claude-accounts/3c5e8a10",
                           "auth": "yes"},
                          {"id": "8f21b6d4", "name": "Team", "home": "/root/.orbit/claude-accounts/8f21b6d4",
                           "auth": "yes"}]},
            {"engine": "codex", "installed": True, "version": "codex-cli 0.164.0", "auth": "yes", "update": updated()},
            {"engine": "kimi", "installed": True, "version": "2.1.4", "auth": "yes", "update": updated()},
            {"engine": "antigravity", "installed": True, "version": "1.3.4", "auth": "yes", "authSource": "google",
             "update": updated()},
        ],
        # What the runner read before the flip: none of Claude's is drawn while the machine is blocked.
        "planUsage": {"claude": {"provider": "claude", "fiveHour": window(66, 180, 300),
                                 "sevenDay": window(41, 3 * 24 * 60, 10080)},
                      "codex": {"provider": "codex", "primary": window(12, 9 * 60 + 50, 300)}},
        "modelCatalog": {"claude": CLAUDE_MODELS, "codex": CODEX_MODELS},
        "runtimeDefaultModels": {"claude": "claude-opus-5-5", "codex": "gpt-5.6-sol"},
    }


def ev(seq, typ, turn, payload, ts):
    return {"seq": seq, "type": typ, "ts": ts, "turnId": turn, "payload": payload}


EVENTS = {
    "S1": [
        ev(1, "user", "t1", {"text": "The login test fails about one run in five. Find out why and fix it."}, ago(40)),
        ev(2, "assistant", "t1", {"text": "The test waits a fixed **500 ms** for the session cookie, and the token "
                                          "refresh sometimes takes longer under load. I replaced the sleep with a "
                                          "wait on the cookie itself.", "messageId": "m2"}, ago(36)),
        ev(3, "result", "t1", {"subtype": "success", "result": "done", "durationMs": 240000}, ago(36)),
        ev(4, "user", "t2", {"text": "Now do the same for the sign-up test."}, ago(3)),
        ev(5, "error", "t2", {"message": REFUSAL}, ago(3)),
    ],
    "S2": [
        ev(1, "user", "t1", {"text": "Highlight the matches in wiki search results."}, ago(90)),
        ev(2, "assistant", "t1", {"text": "Done — matches are highlighted in titles and in the body excerpt.",
                                  "messageId": "m2"}, ago(84)),
        ev(3, "result", "t1", {"subtype": "success", "result": "done"}, ago(84)),
    ],
    "S3": [
        ev(1, "user", "t1", {"text": "Bump the runner's Go toolchain to 1.27."}, ago(300)),
        ev(2, "assistant", "t1", {"text": "Bumped to Go 1.27, and the runner's tests pass.", "messageId": "m2"},
           ago(290)),
        ev(3, "result", "t1", {"subtype": "success", "result": "done"}, ago(290)),
    ],
}

TITLES = {"S1": "Fix the flaky login test", "S2": "Wiki search: highlight matches", "S3": "Go 1.27 for the runner"}


def conversation(sid):
    events = EVENTS[sid]
    said = [e for e in events if e["type"] == "assistant"][-1]
    held = sid == "S1"
    status = "PENDING" if held else "AWAITING_INPUT"
    row = {"id": sid, "title": TITLES[sid], "status": status, "runStatus": status,
           "runState": "QUEUED" if held else "AWAITING_INPUT", "sessionState": status,
           "lifecycleState": "OPEN", "filingState": "OPEN", "agentId": "a1",
           "agent": {"id": "a1", "name": "orbit-develop"}, "assignedRunnerId": "hpc", "engine": "claude",
           "provider": STATE["provider"] if held else "claude", "model": "claude-opus-5-5", "effort": "high",
           "permissionMode": "default", "taskId": None, "projectId": None, "createdAt": events[0]["ts"],
           "updatedAt": events[-1]["ts"], "lastTurnAt": events[-1]["ts"], "pendingApprovals": 0, "tags": [],
           "folderId": None, "source": "USER", "numTurns": 1,
           "lastAssistantText": said["payload"]["text"]}
    if held:
        row["error"] = REFUSAL
    return row


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
        if parts == ["api", "users", "me"]:
            return self.send(200, {"id": "u1", "email": "owner@example.com", "name": "Owner", "role": "MEMBER",
                                   "createdAt": ago(90 * 24 * 60), "preferences": {"theme": "system"}})
        if parts == ["api", "agents"]:
            return self.send(200, AGENTS)
        if parts == ["api", "agents", "a1"]:
            return self.send(200, AGENTS[0])
        if parts == ["api", "runners"]:
            return self.send(200, [runner()])
        if parts == ["api", "runners", "hpc"]:
            return self.send(200, runner())
        if parts == ["api", "runners", "hpc", "login"]:
            return self.send(200, {"status": None, "engine": None, "url": None, "userCode": None,
                                   "message": None, "account": None})
        if parts == ["api", "events"]:
            return self.keepalive()
        if parts == ["api", "providers"]:
            return self.send(200, PROVIDERS)
        if parts in (["api", "providers", "mine"], ["api", "providers", "pools"], ["api", "providers", "shared-pools"],
                     ["api", "session-tags"], ["api", "session-folders"], ["api", "task-lists"], ["api", "watches"],
                     ["api", "share-links"], ["api", "projects"], ["api", "sessions", "counts"]):
            return self.send(200, [])
        if parts == ["api", "sessions"]:
            view = query.get("view", ["open"])[0]
            return self.send(200, [conversation(s) for s in TITLES] if view == "open" else [])
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"] and parts[2] in TITLES:
            sid, rest = parts[2], parts[3:]
            if rest == []:
                return self.send(200, conversation(sid))
            if rest == ["events"]:
                return self.stream(sid, int(query.get("sinceSeq", ["0"])[0] or 0))
            if rest == ["events", "page"]:
                return self.send(200, {"events": EVENTS[sid], "hasMore": False, "before": None, "after": None})
            if rest in (["turns"], ["approvals"]):
                return self.send(200, [])
            return self.send(404, {"error": "not in the probe"})
        return self.send(404, {"error": "not in the probe"})

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

    def stream(self, sid, sent):
        """Replay what follows `sinceSeq` (SSE `data:` frames, the server's framing), then keep the stream
        alive inside the clients' 45 s watchdog."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        last_ping = time.time()
        try:
            while True:
                for e in EVENTS[sid]:
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
        if parts == ["api", "runners", "hpc", "region-check"]:
            # Check again: recorded, and the check it asks for comes back at once — still blocked.
            asked = now()
            STATE["checks"] += 1
            STATE["checkedAt"] = asked
            return self.send(201, {"requestedAt": asked})
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not change anything"})

    def do_PATCH(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        body = self.body()
        if parts == ["api", "sessions", "S1", "config"] and body.get("provider"):
            STATE["provider"] = body["provider"]
            return self.send(200, {"ok": True})
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not change anything"})

    def do_DELETE(self):
        self.body()
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not change anything"})


if __name__ == "__main__":
    class LoopbackServer(ThreadingHTTPServer):
        daemon_threads = True

        # HTTPServer.server_bind resolves its own name (socket.getfqdn), a reverse lookup that on macOS can
        # raise the "find devices on local networks" prompt.
        def server_bind(self):
            import socketserver
            socketserver.TCPServer.server_bind(self)
            self.server_name, self.server_port = "localhost", self.server_address[1]

    server = LoopbackServer(("127.0.0.1", PORT), Handler)
    print("stub listening on 127.0.0.1:%d (python %s)" % (PORT, sys.version.split()[0]), flush=True)
    server.serve_forever()
