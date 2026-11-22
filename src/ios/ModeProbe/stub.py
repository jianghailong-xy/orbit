from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from urllib.parse import urlparse


def stamp(offset):
    return (today + timedelta(seconds=offset)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


today = datetime.now(timezone.utc) - timedelta(minutes=20)
model = "claude-opus-5-5"
agent = {"id": "a1", "name": "Orbit", "provider": "claude", "lastProvider": "claude",
         "runnerId": "r1", "enabled": True, "enableWorktree": False,
         "workDir": "/workspace/orbit", "workDirExists": True}
runner = {"id": "r1", "name": "Mac mini", "online": True, "status": "ONLINE",
          "version": "0.1.120", "maxConcurrent": 4, "lastHeartbeatAt": stamp(1100),
          "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}]}
user = {"id": "u1", "email": "user@example.test", "name": "Orbit User", "role": "MEMBER",
        "createdAt": stamp(0), "preferences": {"defaultPermissionMode": "auto", "theme": "light"}}


def change(before, after, cause, age, client=None):
    return {"fromMode": before, "toMode": after, "cause": cause, "at": stamp(age), "client": client}


def session(id, title, changes, status="AWAITING_INPUT", model=model):
    latest = changes[-1] if changes else {}
    return {"id": id, "title": title, "status": status, "runStatus": status,
            "provider": "claude", "engine": "claude", "model": model, "permissionMode": "auto",
            "actualPermissionMode": latest.get("toMode"), "actualPermissionModeAt": latest.get("at"),
            "permissionModeChanges": changes, "agentId": "a1", "assignedRunnerId": "r1",
            "numTurns": 1 if changes else 0, "createdAt": stamp(1), "updatedAt": stamp(90)}


claim = change(None, "auto", "CLAIM", 3)
sessions = {
    "S1": session("S1", "Review the release notes", [claim]),
    "S2": session("S2", "Review the release notes",
                  [claim, change("auto", "default", "ENGINE_REPORT", 4)]),
    "S3": session("S3", "Review the release notes",
                  [claim, change("auto", "default", "OWNER_PICK", 13, "ios"),
                   change("default", "auto", "RUNNER_CORRECTION", 14),
                   change("auto", "default", "ENGINE_REPORT", 15),
                   change("default", "auto", "RESPAWN", 16)]),
    "S4": session("S4", "New review", [], "PENDING", "claude-haiku-4-5"),
}
events = [
    {"seq": 1, "type": "user", "ts": stamp(6), "payload": {"text": "Review the release notes."}},
    {"seq": 2, "type": "assistant", "ts": stamp(10),
     "payload": {"text": "The release notes are ready for review."}},
]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlparse(self.path).path.removeprefix("/api/")
        parts = path.split("/")
        if path == "users/me":
            body = user
        elif path == "agents":
            body = [agent]
        elif path == "agents/a1":
            body = agent
        elif path in ("runners", "runners/r1"):
            body = [runner] if path == "runners" else runner
        elif path in ("sessions", "agents/a1/sessions"):
            body = [{k: v for k, v in row.items() if k != "permissionModeChanges"} for row in sessions.values()]
        elif parts[0] == "sessions" and len(parts) >= 2 and parts[1] in sessions:
            if len(parts) == 2:
                body = {**sessions[parts[1]], "agent": agent}
            elif parts[2:4] == ["events", "page"]:
                body = {"events": [] if parts[1] == "S4" else events, "hasMore": False}
            else:
                body = []
        else:
            body = []
        payload = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


ThreadingHTTPServer(("127.0.0.1", 8765), Handler).serve_forever()
