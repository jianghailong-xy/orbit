#!/usr/bin/env python3
# Evidence probe (task 34no050naUDViWDBEtXaZ): the slice of the Orbit API that Settings -> Machines & models
# -> Add Runner reads on the iPhone app, with one request `orbit register` made, code ABCDE-FGH23, for a
# machine named devbox (hostname vmi3337007). The account has one machine, HPC, online and signed in, so
# the page under the sheet needs nothing of anyone.
#
# GET /api/runners/device/ABCDE-FGH23 answers as runners.service.ts getDeviceEnrollment does; POST …/approve
# and …/deny decide a PENDING request, and deciding one already decided the other way is refused 409
# DEVICE_ENROLLMENT_DECIDED in the server's words (deviceDecidedAlready). Any other code is a 404.
#
# POST /__set {"status": "PENDING" | "APPROVED" | "DENIED", "conflict": bool, "lastSeenMinutes": n | null,
#              "stale": bool, "hold": seconds}
#   status           what the request is
#   conflict         a runner of the account is already called devbox; lastSeenMinutes is how long ago it
#                    last checked in (null: never)
#   stale            the lookup still answers PENDING whatever status says, as a request decided in a
#                    browser after the sheet read it
#   hold             each decision waits this long before it answers, so a picture can catch it in flight
# POST /__reset puts it all back. Every request is logged with its body; anything not served is a 404.
# All data is made up.
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
CODE = "ABCDE-FGH23"
RUNNER_ID = "0199f0a8-3c2e-7b51-9a6e-1f2d3c4b5a69"


def at(minutes):
    t = datetime.now(timezone.utc) + timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def fresh_state():
    return {"status": "PENDING", "conflict": False, "lastSeenMinutes": None, "stale": False, "hold": 0}


STATE = fresh_state()

AGENTS = [{"id": "a1", "name": "orbit-develop", "provider": "claude", "lastProvider": "claude", "runnerId": "hpc",
           "enabled": True, "enableWorktree": False, "effort": "", "workDir": "/root/orbit",
           "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}]


def runner():
    return {"id": "hpc", "name": "HPC", "displayName": "HPC", "hostname": "workstation", "online": True,
            "status": "ONLINE", "version": "0.1.240", "maxConcurrent": 8, "activeSessions": 1,
            # Stamped now: a once-stamped heartbeat would grey the machine out within the run.
            "lastHeartbeatAt": at(-0.2),
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.296 (Claude Code)", "auth": "yes",
                         "update": {"status": "ok", "at": at(-6), "okAt": at(-6)}}]}


def device():
    status = "PENDING" if STATE["stale"] else STATE["status"]
    seen = STATE["lastSeenMinutes"]
    return {"userCode": CODE, "name": "devbox", "hostname": "vmi3337007", "labels": [], "maxConcurrent": 16,
            "status": status, "nameConflict": STATE["conflict"],
            "existingLastSeenAt": at(-seen) if STATE["conflict"] and seen is not None else None,
            "runnerId": RUNNER_ID if status == "APPROVED" else None,
            "createdAt": at(-0.3), "expiresAt": at(9.7)}


def decide(wanted):
    """runners.service.ts: a PENDING request takes the decision; the same decision again is answered as it
    stands; the other way is a 409 that says what it was."""
    if STATE["hold"]:
        time.sleep(float(STATE["hold"]))
    if STATE["status"] == "PENDING":
        STATE["status"] = wanted
        STATE["stale"] = False
    if STATE["status"] == wanted:
        if wanted == "APPROVED":
            return 201, {"ok": True, "name": "devbox", "replaced": STATE["conflict"], "runnerId": RUNNER_ID}
        return 201, {"ok": True, "name": "devbox"}
    message = ("This registration request was denied — run `orbit register` again" if STATE["status"] == "DENIED"
               else "This registration request was already approved")
    return 409, {"statusCode": 409, "code": "DEVICE_ENROLLMENT_DECIDED", "message": message}


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
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if parts == ["api", "agents"]:
            return self.send(200, AGENTS)
        if parts == ["api", "agents", "a1"]:
            return self.send(200, AGENTS[0])
        if parts == ["api", "runners"]:
            return self.send(200, [runner()])
        if parts == ["api", "runners", "hpc"]:
            return self.send(200, runner())
        if parts[:3] == ["api", "runners", "device"] and len(parts) == 4:
            if parts[3] != CODE:
                return self.send(404, {"statusCode": 404, "message": "enrollment request not found or expired",
                                       "error": "Not Found"})
            return self.send(200, device())
        if parts in (["api", "providers"], ["api", "providers", "mine"], ["api", "providers", "pools"],
                     ["api", "providers", "shared-pools"], ["api", "session-tags"], ["api", "session-folders"],
                     ["api", "task-lists"], ["api", "watches"], ["api", "share-links"], ["api", "projects"],
                     ["api", "sessions"], ["api", "sessions", "counts"]):
            return self.send(200, [])
        return self.send(404, {"error": "not in the probe"})

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        body = self.body()
        if parts == ["__reset"]:
            STATE.clear()
            STATE.update(fresh_state())
            return self.send(200, {"ok": True})
        if parts == ["__set"]:
            for key in fresh_state():
                if key in body:
                    STATE[key] = body[key]
            return self.send(200, STATE)
        if parts[:3] == ["api", "runners", "device"] and len(parts) == 5 and parts[4] in ("approve", "deny"):
            if parts[3] != CODE:
                return self.send(404, {"statusCode": 404, "message": "enrollment request not found or expired",
                                       "error": "Not Found"})
            return self.send(*decide("APPROVED" if parts[4] == "approve" else "DENIED"))
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not change anything"})

    def do_PATCH(self):
        self.body()
        return self.send(404, {"error": "not in the probe"})

    def do_DELETE(self):
        self.body()
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
