#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API that Settings → Access tokens
# touches in the native clients. One account with six personal access tokens — three that work
# (one never expires, one confined to a workspace, one issued by `orbit login`) and three that
# stopped (revoked with a password change, revoked by an administrator, expired). A real
# `DELETE /api/access-tokens/:id` from the app revokes one, and the next list shows it so.
# Every request is logged; anything not served is a 404. All data is made up.
import json
import sys
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"


def at(minutes):
    t = datetime.now(timezone.utc) + timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


DAY = 24 * 60
USER = {"id": "u1", "email": "hailong@example.com", "name": "Hailong", "role": "MEMBER",
        "createdAt": at(-90 * DAY), "preferences": {"theme": "system"}}
RUNNER = {"id": "r1", "name": "hpc", "displayName": "hpc", "online": True, "status": "ONLINE",
          "version": "0.1.215", "maxConcurrent": 4, "lastHeartbeatAt": at(0), "capabilities": [],
          "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}]}
AGENT = {"id": "a1", "name": "orbit", "provider": "claude", "lastProvider": "claude", "runnerId": "r1",
         "enabled": True, "enableWorktree": False, "effort": "", "workDir": "/srv/orbit",
         "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}

READ = ["tasks:read", "projects:read", "sessions:read", "workspaces:read", "runners:read", "wiki:read",
        "events:read"]
ALL = ["tasks:read", "tasks:write", "projects:read", "projects:write", "sessions:read", "sessions:write",
       "workspaces:read", "workspaces:write", "runners:read", "wiki:read", "wiki:write", "events:read"]


def token(tid, name, hint, scopes, created_days_ago, expires_in_days, via="WEB", used_minutes_ago=None,
          ip=None, workspaces=None, revoked=None, state="ACTIVE"):
    workspaces = workspaces or []
    return {
        "id": tid, "name": name, "tokenHint": hint, "scopes": scopes,
        "workspaceIds": [w["id"] for w in workspaces], "workspaces": workspaces,
        "expiresAt": None if expires_in_days is None else at(expires_in_days * DAY - created_days_ago * DAY),
        "createdVia": via,
        "lastUsedAt": None if used_minutes_ago is None else at(-used_minutes_ago),
        "lastUsedIp": ip, "lastUsedUserAgent": "orbit-cli/0.1.215" if ip else None,
        "revokedAt": None if revoked is None else at(-revoked[0] * DAY),
        "revokedReason": None if revoked is None else revoked[1],
        "createdAt": at(-created_days_ago * DAY), "state": state,
    }


def tokens():
    out = [
        token("34ajPat1", "deploy-bot", "k3Fq", ALL, 12, None, used_minutes_ago=200, ip="203.0.113.7"),
        token("34ajPat2", "ci-runner", "Wd8e", ["tasks:read", "tasks:write", "sessions:read"], 0, 90,
              used_minutes_ago=0, ip="10.0.4.12", workspaces=[{"id": "w1", "name": "orbit"}]),
        token("34ajPat3", "MacBook Air", "p0Lx", ALL, 20, 365, via="CLI_DEVICE",
              used_minutes_ago=2 * DAY + 4 * 60, ip="198.51.100.23"),
        token("34ajPat4", "weekend-script", "Zt2a", READ, 40, 30, used_minutes_ago=12 * DAY,
              ip="192.0.2.44", revoked=(10, "EXPIRED"), state="EXPIRED"),
        token("34ajPat5", "old-iphone-shortcut", "Hq7c", ["tasks:read", "tasks:write"], 60, None,
              revoked=(8, "PASSWORD_CHANGED"), state="REVOKED"),
        token("34ajPat6", "intern-laptop", "Rb5n", READ, 30, 90, via="CLI_DEVICE", used_minutes_ago=6 * DAY,
              ip="198.51.100.80", revoked=(5, "ADMIN"), state="REVOKED"),
    ]
    for t in out:
        if t["id"] in STATE["revoked"]:
            t.update(state="REVOKED", revokedAt=STATE["revoked"][t["id"]], revokedReason="USER")
    return out


STATE = {}


def reset():
    STATE.update(revoked={})


reset()


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
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if parts == ["api", "users", "me"]:
            return self.send(200, USER)
        if parts == ["api", "access-tokens"]:
            return self.send(200, {"tokens": tokens()})
        if parts == ["api", "share-links"]:
            return self.send(200, {"links": []})
        if parts == ["api", "agents"]:
            return self.send(200, [AGENT])
        if parts == ["api", "agents", "a1"]:
            return self.send(200, AGENT)
        if parts == ["api", "runners"]:
            return self.send(200, [RUNNER])
        if parts == ["api", "runners", "r1"]:
            return self.send(200, RUNNER)
        if parts in (["api", "sessions"], ["api", "providers"], ["api", "providers", "mine"],
                     ["api", "providers", "pools"], ["api", "providers", "shared-pools"],
                     ["api", "session-tags"], ["api", "session-folders"], ["api", "task-lists"],
                     ["api", "watches"], ["api", "projects"]):
            return self.send(200, [])
        return self.send(404, {"error": "not in the probe"})

    def do_DELETE(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if len(parts) == 3 and parts[:2] == ["api", "access-tokens"]:
            found = [t for t in tokens() if t["id"] == parts[2]]
            if not found:
                return self.send(404, {"statusCode": 404, "message": "access token not found"})
            if found[0]["state"] == "ACTIVE":
                STATE["revoked"][parts[2]] = at(0)
            row = [t for t in tokens() if t["id"] == parts[2]][0]
            return self.send(200, {"id": row["id"], "revokedAt": row["revokedAt"],
                                   "revokedReason": row["revokedReason"]})
        return self.send(404, {"error": "not in the probe"})

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            self.rfile.read(n)
        if parts == ["__reset"]:
            reset()
            return self.send(200, {"ok": True})
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

    def do_PATCH(self):
        return self.send(404, {"error": "not in the probe"})

    def do_PUT(self):
        return self.send(404, {"error": "not in the probe"})


if __name__ == "__main__":
    class LoopbackServer(ThreadingHTTPServer):
        # HTTPServer.server_bind resolves its own name (socket.getfqdn), a reverse lookup that on
        # macOS raises the "find devices on local networks" prompt over the app being photographed.
        def server_bind(self):
            import socketserver
            socketserver.TCPServer.server_bind(self)
            self.server_name, self.server_port = "localhost", self.server_address[1]

    server = LoopbackServer(("127.0.0.1", PORT), Handler)
    print("stub listening on 127.0.0.1:%d (python %s)" % (PORT, sys.version.split()[0]), flush=True)
    server.serve_forever()
