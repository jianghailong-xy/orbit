#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API the iPhone app reads on the screens of
# the Cursor CLI boards iOS 1-6 (docs/mocks/cursor-engine/), holding the account the boards draw — the one
# the web's P7a captures serve (docs/evidence/cursor-engine/p7a/capture/data.mjs), in the shapes the shipped
# runner and server send:
#
#   hpc         runner 0.1.262 running the pinned Cursor CLI 2026.10.14-941492e: Default (Free plan, no
#               share reported) and Team (Pro, 34% of this month) signed in; Add account declared
#   build-box   knows Cursor CLI, none installed                      (Not installed)
#   mac-studio  runner 0.1.236, which predates Cursor CLI             (Update runner)
#   gpu-box     Cursor CLI 2026.10.16-e3cb207, not the pinned build   (Unsupported version)
#   lab         the pinned build, signed out                          (Not signed in)
#   API keys    DeepSeek, Gemini, Kimi (Moonshot), Z.AI (GLM), and two Cursor keys: Cursor (Cursor accepted
#               it 4 min ago) and Cursor 2 (Cursor refused it)
#   orbit       the workspace on hpc; box, mac, gpu and lab, one on each other machine
#   C1          a Cursor CLI session on Auto that has talked (boards iOS 5 ①, iOS 6 ②④)
#   C2          the same conversation on Claude Opus 5.5, High, at 1M and Fast (iOS 5 ②): its model value
#               carries the two settings, claude-opus-5-5[context=1m,fast=true] (the coordinator's convention)
#   C3          a Cursor CLI turn running, a message queued behind it (iOS 5 ③)
#   C4          a turn that met Cursor's usage limit on Default's Free plan (iOS 5 ⑧)
#
# The sign-in relay is the runner's, played here: POST .../login starts it, pending — the runner not yet
# checked in — until POST /__set {"login": "link"} hands over the cursor.com link with the time it has left
# (and keeps handing it to every sign-in after, until a reset); {"login": "expire" | "approve"} ends it
# either way — approving one that added an account adds "Work". Removing Team is refused as the runner refuses an
# account in use. POST /__set {"keys": "nocursor"} takes the Cursor keys away (the board's "signed out, no
# Cursor key"), {"keys": "onecursor"} leaves the one Cursor accepted (the key iOS 6 draws); {"catalog": "short"} has
# the runners list three Cursor models, so a model menu's last rows fit on a phone; POST /__reset puts
# everything back (every UI test calls it before launching). Every
# request is logged; anything not served is a 404. All data is made up.
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
PIN = "2026.10.14-941492e"
TEAM = "5c2e91a0"
WORK = "9b1f3c20"


def ago(minutes):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def ahead(minutes):
    return ago(-minutes)


def checked():
    return {"status": "checked", "at": ago(6), "okAt": ago(6)}


def fresh_state():
    return {"keys": "all", "catalog": "full", "login": None, "outcome": None, "link": False, "added": False,
            "removeRefused": False, "rechecked": {}}


STATE = fresh_state()

CLAUDE = {"engine": "claude", "installed": True, "auth": "yes", "version": "2.1.302", "update": checked(),
          "accounts": [{"id": "default", "name": "Personal", "home": "/root/.claude", "auth": "yes"},
                       {"id": "slot-2", "name": "Work", "home": "/root/.orbit/claude-accounts/1e84046c", "auth": "yes"}]}
CLAUDE_ONE = {"engine": "claude", "installed": True, "auth": "yes", "version": "2.1.302", "update": checked()}
CODEX = {"engine": "codex", "installed": True, "auth": "yes", "version": "0.164.0", "update": checked()}
KIMI = {"engine": "kimi", "installed": True, "auth": "yes", "version": "2.1.4", "update": checked(),
        "kimiRegion": "global", "accounts": [{"id": "default", "home": "/root/.kimi-code", "auth": "yes",
                                               "kimiRegion": "global"}]}
ANTIGRAVITY = {"engine": "antigravity", "installed": True, "auth": "yes", "version": "1.3.4", "update": checked(),
               "authSource": "google", "accounts": [{"id": "default", "home": "/root/.gemini", "auth": "yes"}]}
OPENCODE = {"engine": "opencode", "installed": True, "auth": "unknown", "version": "1.18.40", "update": checked()}
DSH = {"engine": "dsh", "installed": True, "auth": "unknown", "version": "0.2.0",
       "dsh": {"versionCompatible": True, "credentialPresent": True, "modelCatalogReadable": True,
               "requestValidation": "unknown", "sandboxEnforcement": "full"}}


def cursor_accounts():
    rows = [{"id": "default", "home": "/root/.orbit/cursor/default", "auth": "yes"},
            {"id": TEAM, "name": "Team", "home": "/root/.orbit/cursor-accounts/" + TEAM, "auth": "yes"}]
    if STATE["added"]:
        rows.append({"id": WORK, "name": "Work", "home": "/root/.orbit/cursor-accounts/" + WORK, "auth": "yes"})
    return rows


def cursor_health(**over):
    """The runner's report of the pinned build (cursor_health.go, cursor_install.go updateCursor)."""
    row = {"engine": "cursor", "installed": True, "auth": "yes", "version": PIN,
           "update": {"status": "checked", "at": ago(6), "okAt": ago(6), "latest": PIN,
                      "message": "Pinned to %s; newer Cursor CLI releases are not followed." % PIN},
           "accounts": cursor_accounts()}
    row.update(over)
    return row


def cursor_usage(default_spent=False):
    """P6a's per-account reading (PlanUsage.cursor): Default on the Free plan, which reports no share used
    (its 0% is no reading); Team on Pro at 34% of this month; Work, once added, at 3%."""
    default = {"startsAt": ago(25 * 1440), "resetsAt": ahead(4 * 1440 + 12 * 60)}
    if default_spent:
        default["limitReachedAt"] = ago(16)
    accounts = {TEAM: {"provider": "cursor", "account": TEAM, "planName": "Pro",
                       "includedUsage": {"period": "monthly", "startsAt": ago(24 * 1440),
                                         "resetsAt": ahead(5 * 1440 + 4 * 60), "percentUsed": 34},
                       "fetchedAt": ago(4)}}
    if STATE["added"]:
        accounts[WORK] = {"provider": "cursor", "account": WORK, "planName": "Pro",
                          "includedUsage": {"period": "monthly", "startsAt": ago(2 * 1440),
                                            "resetsAt": ahead(17 * 1440), "percentUsed": 3},
                          "fetchedAt": ago(1)}
    return {"provider": "cursor", "account": "default", "planName": "Free", "includedUsage": default,
            "fetchedAt": ago(4), "accounts": accounts}


def opt(pid, label, category, values, default):
    return {"id": pid, "label": label, "category": category, "default": default,
            "values": [{"value": v, "label": l} for v, l in values]}


# Cursor CLI's ACP catalogue as the runner reports it (cursor_models.go): Auto is `default`, with no
# parameters; the rest carry their effort as reasoning levels, beside every parameter Cursor lists, by
# Cursor's own names (docs/evidence/cursor-cli/2026.10.14-941492e/p0c parameterized-model-picker).
CURSOR_CATALOG = [
    {"value": "default", "label": "Auto"},
    {"value": "claude-opus-5-5", "label": "Claude Opus 5.5", "reasoningLevels": ["low", "medium", "high", "xhigh", "max"],
     "defaultReasoningLevel": "medium",
     "parameters": [opt("context", "Context", "model_config", [("300k", "300K"), ("1m", "1M")], "300k"),
                    opt("effort", "Effort", "thought_level", [("low", "Low"), ("medium", "Medium"), ("high", "High"),
                                                              ("xhigh", "Extra High"), ("max", "Max")], "medium"),
                    opt("fast", "Fast", "model_config", [("false", "Off"), ("true", "Fast")], "false")]},
    {"value": "claude-sonnet-5-5", "label": "Claude Sonnet 5.5", "reasoningLevels": ["low", "medium", "high"],
     "defaultReasoningLevel": "medium"},
    {"value": "gpt-5.5", "label": "GPT-5.5", "reasoningLevels": ["low", "medium", "high", "xhigh"],
     "defaultReasoningLevel": "medium"},
    {"value": "gemini-3.8-pro", "label": "Gemini 3.8 Pro", "reasoningLevels": ["low", "high"],
     "defaultReasoningLevel": "high"},
    {"value": "grok-4.7", "label": "Grok 4.7", "reasoningLevels": ["low", "high"], "defaultReasoningLevel": "high"},
    {"value": "composer-2.5", "label": "Composer 2.5"},
]


def cursor_catalog():
    """The runner's Cursor catalogue: all of it, or Auto, Claude Opus 5.5 and Composer 2.5 alone."""
    if STATE.get("catalog") == "short":
        return [row for row in CURSOR_CATALOG if row["value"] in ("default", "claude-opus-5-5", "composer-2.5")]
    return CURSOR_CATALOG
CURSOR_CAPS = ["provider:cursor", "cursor-account-login/v1", "cursor-account-remove/v1", "cursor-key-check/v1"]


def runner(**over):
    row = {"online": True, "status": "ONLINE", "maxConcurrent": 8, "activeSessions": 0, "lastHeartbeatAt": ago(0.2),
           "enrolledAt": "2026-06-18T02:00:00Z", "minFreeDiskMb": None, "runsAsRoot": False, "capabilities": [],
           "selfUpdate": {"state": "enabled", "installDir": "/usr/local/bin"}, "commands": [], "skills": []}
    row.update(over)
    return row


def runners():
    hpc = runner(
        id="hpc", name="hpc", displayName="hpc", hostname="hpc-01", version="0.1.262", maxConcurrent=16,
        activeSessions=3, position=0,
        capabilities=["provider:dsh", "antigravity-account-login/v1", "kimi-account-login/v1",
                      "kimi-account-remove/v1", "kimi-account-move/v1"] + CURSOR_CAPS,
        antigravity={"supported": True, "installed": True, "version": "1.3.4", "envKeyAvailable": True,
                     "authSource": "google", "googleLogin": "available"},
        planUsage={"claude": {"provider": "claude", "fiveHour": {"utilization": 23, "resetsAt": ahead(126)},
                              "sevenDay": {"utilization": 41, "resetsAt": ahead(3 * 1440)}, "fetchedAt": ago(2)},
                   "codex": {"provider": "codex", "primary": {"utilization": 12, "resetsAt": ahead(200),
                                                              "windowDurationMins": 300},
                             "secondary": {"utilization": 41, "resetsAt": ahead(4 * 1440),
                                           "windowDurationMins": 10080}, "fetchedAt": ago(3)},
                   "cursor": cursor_usage(default_spent=STATE.get("spent", False))},
        engines=[CLAUDE, CODEX, KIMI, ANTIGRAVITY, OPENCODE, DSH, cursor_health()],
        modelCatalog={"claude": [{"value": "claude-opus-5-5", "label": "Opus 5.5", "contextWindow": 1000000,
                                  "reasoningLevels": ["low", "medium", "high", "xhigh", "max"]},
                                 {"value": "claude-sonnet-5-5", "label": "Sonnet 5.5", "contextWindow": 1000000}],
                      "dsh": [{"value": "deepseek-v4-pro", "label": "DeepSeek V4 Pro"}],
                      "cursor": cursor_catalog()},
        runtimeDefaultModels={"claude": "claude-opus-5-5", "dsh": "deepseek-v4-pro"})
    if STATE["removeRefused"]:
        hpc["accountRemove"] = {"engine": "cursor", "account": TEAM, "status": "failed",
                                "message": "Team is in use: 2 sessions on hpc are running on it. Remove it once "
                                           "they finish. Its sign-in is untouched."}
    box = runner(id="build-box", name="build-box", displayName="build-box", hostname="build-box", version="0.1.262",
                 maxConcurrent=4, position=1,
                 engines=[CLAUDE_ONE, CODEX, OPENCODE,
                          {"engine": "cursor", "installed": False, "auth": "unknown",
                           "installationError": "CURSOR_NOT_INSTALLED: Cursor CLI %s is not installed in Orbit's "
                                                "version directory" % PIN}])
    mac = runner(id="mac-studio", name="mac-studio.local", displayName="mac-studio", hostname="mac-studio.local",
                 version="0.1.236", maxConcurrent=4, activeSessions=1, position=2,
                 engines=[CLAUDE_ONE, CODEX, {"engine": "kimi", "installed": False, "auth": "unknown"}])
    gpu = runner(id="gpu-box", name="gpu-box", displayName="gpu-box", hostname="gpu-box", version="0.1.262",
                 maxConcurrent=4, position=3,
                 engines=[CLAUDE_ONE, CODEX,
                          {"engine": "cursor", "installed": True, "auth": "unknown", "version": "2026.10.16-e3cb207",
                           "installationError": "CURSOR_VERSION_INCOMPATIBLE: Cursor CLI 2026.10.16-e3cb207 is not "
                                                "the version Orbit runs (%s)" % PIN}])
    lab = runner(id="lab", name="lab", displayName="lab", hostname="lab-02", version="0.1.262", maxConcurrent=4,
                 position=4, capabilities=["provider:cursor"],
                 engines=[CLAUDE_ONE, cursor_health(auth="no", accounts=[{"id": "default", "auth": "no",
                                                                          "home": "/root/.orbit/cursor/default"}])],
                 modelCatalog={"cursor": cursor_catalog()})
    return [hpc, box, mac, gpu, lab]


def key(**over):
    row = {"runtime": "claude", "engines": ["claude", "opencode"], "models": [], "defaultModel": None,
           "followsPreset": True, "enabled": True, "hasApiKey": True, "poolRefusal": None, "lastUsedAt": ago(90)}
    row.update(over)
    return row


def checked_at(pid):
    """When the key was last checked: 4 minutes ago, or when Check Again asked."""
    at = STATE["rechecked"].get(pid)
    return datetime.fromtimestamp(at, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z") if at else ago(4.2)


def own_keys():
    keys = [
        key(id="p-ds", slug="deepseek", label="DeepSeek", engines=["claude", "opencode", "dsh"],
            baseUrl="https://api.deepseek.com/anthropic", presetSlug="deepseek", defaultModel="deepseek-v4-pro",
            models=[{"value": "deepseek-v4-pro", "label": "DeepSeek V4 Pro"},
                    {"value": "deepseek-v4-flash", "label": "DeepSeek V4 Flash"}]),
        key(id="p-gem", slug="gemini", label="Gemini", runtime="antigravity", engines=["antigravity", "opencode"],
            baseUrl="https://generativelanguage.googleapis.com", presetSlug="gemini", defaultModel="gemini-3.8-flash",
            models=[{"value": "gemini-3.8-flash", "label": "Gemini 3.8 Flash"}]),
        key(id="p-kimi", slug="moonshot", label="Kimi (Moonshot)", runtime="kimi", engines=["kimi", "opencode"],
            baseUrl="https://api.moonshot.ai/v1", presetSlug="moonshot", defaultModel="kimi-k2.7-code",
            models=[{"value": "kimi-k2.7-code", "label": "Kimi K2.7 Code"}]),
        key(id="p-glm", slug="glm", label="Z.AI (GLM)", baseUrl="https://api.z.ai/api/anthropic", presetSlug="glm",
            defaultModel="glm-5.2", models=[{"value": "glm-5.2", "label": "GLM-5.2"}]),
    ]
    if STATE["keys"] != "nocursor":
        # A Cursor User API Key as GET /providers/mine serves it (P2): the cursor-api preset, Cursor CLI alone,
        # no models of its own, and its last check (P2 follow-up).
        keys.append(key(id="p-cur", slug="cursor-api", label="Cursor", runtime="cursor", engines=["cursor"],
                        baseUrl="https://api2.cursor.sh", presetSlug="cursor-api", modelsFromRuntime=True,
                        keyCheckState="VALID", keyCheckedAt=checked_at("p-cur"), lastUsedAt=ago(35)))
    if STATE["keys"] == "all":
        keys.append(key(id="p-cur2", slug="cursor-2", label="Cursor 2", runtime="cursor", engines=["cursor"],
                        baseUrl="https://api2.cursor.sh", presetSlug="cursor-api", modelsFromRuntime=True,
                        keyCheckState="INVALID", keyCheckedAt=checked_at("p-cur2"), lastUsedAt=None))
    return keys


def catalogue():
    """GET /providers (ProvidersService.listPublic): the enabled keys, keyless and endpointless."""
    return [{"slug": k["slug"], "label": k["label"], "runtime": k["runtime"], "models": k["models"],
             "defaultModel": k["defaultModel"], "presetSlug": k["presetSlug"], "engines": k["engines"],
             "modelsFromRuntime": k.get("modelsFromRuntime"), "planUsage": None,
             "runsOnOpenCode": "opencode" in k["engines"]}
            for k in own_keys() if k["enabled"]]


def workspace(wid, name, runner_id, **over):
    row = {"id": wid, "name": name, "provider": None, "lastEngine": "claude", "lastProvider": "claude",
           "runnerId": runner_id, "enabled": True, "enableWorktree": True, "effort": "", "workDir": "/root/" + name,
           "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}
    row.update(over)
    return row


AGENTS = [
    workspace("a1", "orbit", "hpc"),
    workspace("a2", "box", "build-box"),
    workspace("a3", "mac", "mac-studio"),
    workspace("a4", "gpu", "gpu-box"),
    workspace("a5", "lab", "lab"),
]

ASKED = "The nightly export test fails about once a week. Find out why and fix it."
ANSWERED = ("The test builds “yesterday” in the machine’s local time zone, so it misses a row just after midnight "
            "UTC. I pinned the test clock to UTC; five runs in a row now pass.")
TITLE = "Fix the flaky export test"


def session(sid, **over):
    row = {"id": sid, "title": TITLE, "status": "AWAITING_INPUT", "runStatus": "AWAITING_INPUT",
           "runState": "AWAITING_INPUT", "lifecycleState": "OPEN", "agentId": "a1",
           "agent": {"id": "a1", "name": "orbit"}, "assignedRunnerId": "hpc", "engine": "cursor", "provider": "cursor",
           "model": "default", "effort": None, "permissionMode": "acceptEdits", "taskId": None, "projectId": None,
           "createdAt": ago(40), "updatedAt": ago(2), "lastTurnAt": ago(2), "pendingApprovals": 0, "tags": [],
           "folderId": None, "source": "USER", "lastAssistantText": ANSWERED, "numTurns": 1,
           "runtimeSessionId": "a6f1c2d4-1e2f-4a3b-9c8d-7e6f5a4b3c2d", "cursorAccount": None,
           "cursorAccountPinned": False}
    row.update(over)
    return row


def sessions():
    return {
        "C1": session("C1"),
        "C2": session("C2", model="claude-opus-5-5[context=1m,fast=true]", effort="high"),
        "C3": session("C3", status="RUNNING", runStatus="RUNNING", runState="RUNNING", numTurns=2,
                      lastAssistantText="Running the full suite now.", engineTurnActive=True,
                      currentTurnStartedAt=ago(0.5)),
        "C4": session("C4", status="FAILED", runStatus="FAILED", runState="FAILED", numTurns=2,
                      cursorAccount="default", lastAssistantText=None,
                      error="You've hit your usage limit on Cursor. Cursor said: \"Upgrade your plan to continue.\""),
    }


def ev(seq, typ, turn, payload, minutes):
    return {"seq": seq, "type": typ, "ts": ago(minutes), "turnId": turn, "payload": payload}


def events(sid):
    first = [ev(1, "user", "t1", {"text": ASKED}, 30),
             ev(2, "assistant", "t1", {"text": ANSWERED, "messageId": "m1"}, 25),
             ev(3, "result", "t1", {"subtype": "success", "result": ANSWERED, "numTurns": 1}, 25)]
    if sid in ("C1", "C2"):
        return first
    if sid == "C3":
        return [ev(1, "user", "t2", {"text": "Run the whole suite before you commit."}, 1),
                ev(2, "assistant", "t2", {"text": "Running the full suite now.", "messageId": "m2"}, 0.8),
                ev(3, "tool_use", "t2", {"id": "tool-1", "name": "Bash",
                                         "input": {"command": "npm test", "description": "Run the full test suite"}}, 0.7)]
    if sid == "C4":
        return [ev(1, "user", "t2", {"text": "Add a regression test for the midnight case too."}, 17),
                ev(2, "error", "t2", {"message": "You've hit your usage limit on Cursor. Cursor said: "
                                                 "\"Upgrade your plan to continue.\""}, 16),
                ev(3, "result", "t2", {"subtype": "error", "isError": True, "result": ""}, 16)]
    return []


def queued(sid):
    if sid != "C3":
        return []
    return [{"turnId": "tq-1", "kind": "message", "placement": "queued", "createdAt": ago(0.3),
             "content": "Also add a line to the changelog.", "attachments": []}]


def login_state():
    login = STATE["login"]
    base = {"status": None, "engine": None, "url": None, "userCode": None, "message": None, "account": None}
    if not login:
        return base
    base.update(engine=login["engine"], account=login.get("account"))
    if STATE["outcome"] == "expire":
        base.update(status="failed", reason="expired",
                    message="The sign-in link expired before anyone signed in with it.")
        return base
    if STATE["outcome"] == "approve":
        base.update(status="done", account=WORK if login.get("accountName") else login.get("account"))
        return base
    if not STATE["link"]:
        base.update(status="pending")
        return base
    base.update(status="awaiting_approval",
                url="https://cursor.com/loginDeepControl?challenge=Zq3J0k1Yx7Nw2uVb5LcTt8RrPp4Hm6GdEe9Ss0Aa1Bb"
                    "&uuid=3f6e2a1c-8b7d-4e5f-9a0b-1c2d3e4f5a6b&mode=login&redirectTarget=cli"
                    "&supportsSelectedTeamLogin=true",
                expiresAt=datetime.fromtimestamp(login["t0"] + 25.9 * 60, timezone.utc)
                .strftime("%Y-%m-%dT%H:%M:%S.000Z"))
    return base


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
        if text:
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
        if len(parts) == 3 and parts[:2] == ["api", "agents"]:
            found = [a for a in AGENTS if a["id"] == parts[2]]
            return self.send(200, found[0]) if found else self.send(404, {"error": "no workspace"})
        if parts == ["api", "runners"]:
            return self.send(200, runners())
        if parts == ["api", "runners", "hpc", "login"]:
            return self.send(200, login_state())
        if len(parts) == 3 and parts[:2] == ["api", "runners"]:
            found = [r for r in runners() if r["id"] == parts[2]]
            return self.send(200, found[0]) if found else self.send(404, {"error": "no runner"})
        if parts == ["api", "providers"]:
            return self.send(200, catalogue())
        if parts == ["api", "providers", "mine"]:
            return self.send(200, own_keys())
        if len(parts) == 5 and parts[:3] == ["api", "providers", "mine"] and parts[4] == "balance":
            if parts[3] != "p-ds":
                return self.send(404, {"error": "no balance"})
            return self.send(200, {"ok": True, "providerId": "p-ds", "isAvailable": True, "fetchedAt": ago(2),
                                   "balances": [{"currency": "CNY", "totalBalance": "110.00",
                                                 "grantedBalance": "10.00", "toppedUpBalance": "100.00"}],
                                   "sharedWith": []})
        if parts in (["api", "providers", "pools"], ["api", "providers", "shared-pools"], ["api", "session-tags"],
                     ["api", "session-folders"], ["api", "task-lists"], ["api", "watches"], ["api", "share-links"],
                     ["api", "projects"]):
            return self.send(200, [])
        if parts == ["api", "sessions"]:
            view = query.get("view", ["open"])[0]
            return self.send(200, list(sessions().values()) if view == "open" else [])
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "events":
            since = int(query.get("sinceSeq", ["0"])[0] or 0)
            return self.stream(parts[2], since)
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"]:
            sid, rest = parts[2], parts[3:]
            row = sessions().get(sid)
            if row is None:
                return self.send(404, {"error": "not in the probe"})
            if rest == []:
                return self.send(200, row)
            if rest == ["events", "page"]:
                return self.send(200, {"events": events(sid), "hasMore": False, "before": None, "after": None})
            if rest == ["turns"]:
                return self.send(200, queued(sid))
            if rest == ["approvals"]:
                return self.send(200, [])
            if rest == ["retry-message"]:
                return self.send(200, {"text": "Add a regression test for the midnight case too.", "attachments": []})
            if rest == ["share"]:
                return self.send(200, {"link": None, "counts": {"messages": 2, "toolCalls": 0}})
            return self.send(404, {"error": "not in the probe"})
        return self.send(404, {"error": "not in the probe"})

    def stream(self, sid, since):
        """The session's events after `sinceSeq` (SSE `data:` frames, the server's own framing), then a
        keepalive inside the clients' 45 s watchdog. Nothing new ever arrives."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        last = time.time()
        try:
            for e in events(sid):
                if e["seq"] > since:
                    self.wfile.write(("data: %s\n\n" % json.dumps(e, ensure_ascii=False)).encode())
            self.wfile.flush()
            while True:
                if time.time() - last > 10:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    last = time.time()
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
            for name in ("keys", "spent", "catalog"):
                if name in body:
                    STATE[name] = body[name]
            if body.get("login") == "link":
                STATE["link"] = True
            if body.get("login") in ("expire", "approve"):
                STATE["outcome"] = body["login"]
                if body["login"] == "approve" and STATE["login"] and STATE["login"].get("accountName"):
                    STATE["added"] = True
            return self.send(200, {k: v for k, v in STATE.items() if k != "login"})
        if parts == ["api", "runners", "hpc", "login"]:
            STATE["login"] = {"engine": body.get("engine"), "account": body.get("account"),
                              "accountName": body.get("accountName"), "t0": time.time()}
            STATE["outcome"] = None
            return self.send(201, login_state())
        if len(parts) == 5 and parts[:2] == ["api", "providers"] and parts[2] == "mine" and parts[4] == "key-check":
            state = "INVALID" if parts[3] == "p-cur2" else "VALID"
            STATE["rechecked"][parts[3]] = time.time()
            return self.send(200, {"ok": state == "VALID", "keyCheck": state, "recorded": True,
                                   "message": "Cursor accepted this key." if state == "VALID" else
                                   "Cursor rejected this key: “The provided API key is invalid.” Save a new key "
                                   "for it, then check it again.",
                                   "keyCheckState": state, "keyCheckedAt": ago(0)})
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not change anything"})

    def do_PATCH(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        body = self.body()
        # Add Account saves the name typed on its card as Rename… does: answered with the account as the
        # runner would list it (the stub's names stay as they are).
        if len(parts) == 6 and parts[:5] == ["api", "runners", "hpc", "accounts", "cursor"]:
            found = [a for a in cursor_accounts() if a["id"] == parts[5]]
            row = dict(found[0]) if found else {"id": parts[5], "auth": "no"}
            row["name"] = body.get("name") or row.get("name")
            return self.send(200, row)
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not change anything"})

    def do_PUT(self):
        self.body()
        return self.send(404, {"error": "not in the probe"})

    def do_DELETE(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if parts == ["api", "runners", "hpc", "login"]:
            STATE["login"] = None
            STATE["outcome"] = None
            return self.send(200, login_state())
        if parts == ["api", "runners", "hpc", "accounts", "cursor", TEAM]:
            STATE["removeRefused"] = True
            return self.send(200, runners()[0]["accountRemove"])
        return self.send(404, {"error": "not in the probe"})


if __name__ == "__main__":
    class LoopbackServer(ThreadingHTTPServer):
        daemon_threads = True

        # HTTPServer.server_bind resolves its own name (socket.getfqdn), a reverse lookup that on macOS
        # can raise the "find devices on local networks" prompt.
        def server_bind(self):
            import socketserver
            socketserver.TCPServer.server_bind(self)
            self.server_name, self.server_port = "localhost", self.server_address[1]

    server = LoopbackServer(("127.0.0.1", PORT), Handler)
    print("stub listening on 127.0.0.1:%d (python %s)" % (PORT, sys.version.split()[0]), flush=True)
    server.serve_forever()
