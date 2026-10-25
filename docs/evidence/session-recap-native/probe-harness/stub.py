#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged; see NOTES.md): the slice of the Orbit API the native
# SESSION LIST reads, for four sessions that cover the rolling recap (0418) and the three lines it
# borrows its row from:
#
#   S1  parked (AWAITING_INPUT), recapText + recapAt — the Open list's second line is the server's
#       recap under its own label ("Recap · <clock>"; SessionLine.recapLabel), not the raw reply.
#   S2  parked, a raw last reply and no recap at all — the fallback the recap was added over.
#   S3  RUNNING with a tool in flight — the live "Running Bash…" outranks the recap, recap or not.
#   S4  parked with a recap written on another day — the label carries the date, because "5:38 PM"
#       alone would misread it as today's.
#
# Started with `--recaps-off`, GET /api/users/me answers `preferences.recaps: false` — the same
# account with its Session recaps switch off — and S1/S4 fall back to their raw last reply while S3
# is untouched: the switch gates the recap line and nothing else. One flag on the same stub, so the
# "switch off" picture is the same app against the same data; the mode is written into the log's
# first line and into every log line's header, so a shots directory cannot be read as the wrong pass.
#
# Every request is logged with its body; anything not served is a 404 and shows up in
# not-served.txt. All data is made up.
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
# The startup switches the run's passes are made of. An argument the stub does not know is refused
# rather than ignored: a typo in run.sh then fails the pass loudly, instead of quietly photographing
# the mode the run did not mean to ask for.
ARGS = sys.argv[3:]
RECAPS_OFF = "--recaps-off" in ARGS
for _arg in ARGS:
    if _arg != "--recaps-off":
        raise SystemExit("stub.py: unknown argument %r (the only flag is --recaps-off)" % _arg)


def ago(minutes):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


DAY = 24 * 60
# The recap the two recapped rows share — S1 parked and S3 running carry the SAME sentence and time,
# so S3 is a row whose recap is held back by its live line, not a row that has none — and the replies
# the rows fall back to when the switch is off.
RECAP_TEXT = "Moved the recap onto the session list row; the three states are covered by tests."
RECAP_REPLY = "Committed the row change."
PLAIN_REPLY = "Pushed the drawer fix."
OTHER_DAY_RECAP = "Tightened the second line's spacing; the badge waits for the design."
OTHER_DAY_REPLY = "Adjusted the row spacing."
# A recap written before today, so its label says which day it was: SessionLine.recapLabel prints a
# bare clock time only for today, and "5:38 PM" alone on an older recap would read as this evening.
# The exact face of the label is the device's own time zone and locale (a runner west of UTC reads
# this one as the evening of the 6th, and "Wed" only where that instant is still the 6th) — which is
# why the test asserts the label's word, "Recap · ", and never a clock it cannot know.
OTHER_DAY_AT = "2026-08-06T17:38:00.000Z"
# S1's recap is minutes old, not a fixed instant: `recapLabel` prints the bare clock time only while
# the instant is TODAY in the device's own zone (Calendar.isDate(inSameDayAs:)), and "today's clock"
# is the state the row is meant to show. A frozen instant would photograph the date form in every
# run past that day, which is S4's picture already. Six minutes back is "today" in any zone except
# the six minutes after local midnight — where the label grows a date and the test still holds,
# because what it asserts is the word "Recap · " and the sentence, not the date.
RECAP_AT = ago(6)


def preferences():
    # Absent means on (`UserPreferences.showRecaps`: only opting out is ever written), so the default
    # `me` carries no `recaps` key at all — what an account that never touched the switch is served —
    # and only the --recaps-off pass names it. That keeps the on pass a check of the absent-means-on
    # half of the preference as well as of the row.
    return {"theme": "system", "recaps": False} if RECAPS_OFF else {"theme": "system"}


USER = {"id": "u1", "email": "hailong@example.com", "name": "Hailong", "role": "MEMBER",
        "createdAt": ago(90 * DAY), "preferences": preferences()}
RUNNER = {"id": "r1", "name": "longdeMac-mini.local", "displayName": "longdeMac-mini.local",
          "online": True, "status": "ONLINE", "version": "0.1.120", "maxConcurrent": 4,
          "lastHeartbeatAt": ago(0), "capabilities": [],
          "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}]}
AGENT = {"id": "a1", "name": "orbit-macos", "provider": "claude", "lastProvider": "claude", "runnerId": "r1",
         "enabled": True, "enableWorktree": True, "effort": "", "workDir": "/srv/orbit",
         "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}


def session(sid, title, state, minutes_ago, **extra):
    """One Open-list row. `state` goes into all four status fields the model resolves between, so
    the row reads the same whichever one an older server would have sent; the nested `agent` is
    what the list payload carries (the flat `agentId` is not sent by a real server) and both are
    here because `SessionFilter.forAgent` accepts either."""
    row = {"id": sid, "publicId": sid, "title": title,
           "status": state, "runStatus": state, "runState": state, "sessionState": state,
           "agentId": "a1", "agent": {"id": "a1", "name": "orbit-macos"},
           "assignedRunnerId": "r1", "provider": "claude",
           "taskId": None, "projectId": None, "projectTitle": None,
           "createdAt": ago(minutes_ago + 60), "updatedAt": ago(minutes_ago),
           "lastTurnAt": ago(minutes_ago)}
    row.update(extra)
    return row


SESSIONS = {
    # Most recent first is not what is asked for — the list sorts itself (`SessionFilter`'s
    # consoleSorted, lastTurnAt desc) — but the times are spread so the four land in a known order
    # and in different iOS recency sections rather than stacking on one timestamp.
    "S3": session("S3", "Rebuilding the transcript page", "RUNNING", 1,
                  lastToolUse="Bash", recapText=RECAP_TEXT, recapAt=RECAP_AT),
    "S1": session("S1", "Recap on the session list row", "AWAITING_INPUT", 3,
                  recapText=RECAP_TEXT, recapAt=RECAP_AT, lastAssistantText=RECAP_REPLY),
    "S2": session("S2", "Drawer shadow fix", "AWAITING_INPUT", 40,
                  lastAssistantText=PLAIN_REPLY),
    "S4": session("S4", "Session row spacing pass", "AWAITING_INPUT", 2 * DAY,
                  recapText=OTHER_DAY_RECAP, recapAt=OTHER_DAY_AT,
                  lastAssistantText=OTHER_DAY_REPLY),
}

# Endpoints the signed-in shells ask for on their own (the sidebar, the poll, the drawer, the
# Settings sheet's own reads). An empty list where the app expects a list — the same answer a new
# account gets — is enough for the list pictures; a read the probe did not think of is a 404 and is
# counted in not-served.txt rather than guessed at.
EMPTY = ["providers", "providers/mine", "providers/pools", "providers/shared-pools", "session-tags",
         "session-folders", "task-lists", "watches", "tasks/active", "tasks/counts", "notifications",
         "projects", "projects/sidebar", "tasks", "skills"]


def log(line):
    """One line in the pass's own log, headed by the time and the mode it served."""
    with open(LOG, "a") as f:
        f.write("%s [%s] %s\n" % (datetime.now().strftime("%H:%M:%S"),
                                  "recaps-off" if RECAPS_OFF else "recaps-on", line))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        self.note(fmt % args)

    def note(self, line):
        log(line)

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
        try:
            return raw.decode(), json.loads(raw.decode() or "{}")
        except ValueError:
            return raw.decode(errors="replace"), {}

    def do_GET(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
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
        # The Open list, the one read these pictures are about. Every spelling answers the plain
        # array: `?view=open` (the conditional read), `?view=open&since=` (the delta read — a bare
        # array is what a server without deltas answers, and the reader falls back to the full
        # read), and the per-session read behind a detail nobody opens here.
        if len(parts) >= 2 and parts[:2] == ["api", "sessions"]:
            rest = parts[2:]
            if rest == []:
                return self.send(200, list(SESSIONS.values()))
            if rest[0] in SESSIONS:
                sid, more = rest[0], rest[1:]
                if more == []:
                    return self.send(200, SESSIONS[sid])
                if more[0] == "events":
                    return self.send(200, {"items": [], "nextCursor": None, "events": []})
                if more[0] in ("retry-message", "capabilities", "owner-confirmation", "watches",
                               "owner-items", "attribution", "created-tasks"):
                    return self.send(200, {} if more[0] != "owner-items" else {"needsYou": [],
                                                                               "withCoordinator": []})
        if parts == ["api", "wiki", "spaces"]:
            return self.send(200, [])
        # The Settings sheet's own reads: the toggle rows render either way, but an empty answer is
        # what an account with none of these gets, and it keeps the 404 count meaningful.
        if len(parts) >= 2 and parts[:2] == ["api", "share-links"]:
            return self.send(200, {"links": []})
        if parts == ["api", "access-tokens"]:
            return self.send(200, {"tokens": []})
        if parts[:1] == ["api"] and len(parts) >= 2 and "/".join(parts[1:]) in EMPTY:
            return self.send(200, [])
        if len(parts) >= 2 and parts[:2] == ["api", "tasks"] and parts[2:] == ["page"]:
            return self.send(200, {"items": [], "nextCursor": None})
        self.note("NOT SERVED %s" % self.path)
        return self.send(404, {"statusCode": 404, "message": "not in the probe"})

    def stream(self):
        """A control stream with nothing to say: keepalives inside the clients' watchdog."""
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
        raw, _body = self.body()
        # The probe's own door, called by the tests' `resetStub()` before each launch ("put back as
        # it starts"). There is nothing mutable to put back here — the rows and the account are
        # constants — so it is answered and named RESET rather than BODY: `writes.txt` is collected
        # from BODY and the mutating verbs, and an entry there would read as a press.
        if parts == ["__reset"]:
            self.note("RESET (nothing is mutable in this stub)")
            return self.send(200, {"ok": True})
        self.note("BODY %s %s" % (self.path, raw))
        # The probe presses nothing: the rows are read, not acted on, and a write it does not know
        # about is a bug in the probe rather than a state to fake. `writes.txt` stays empty when the
        # pass is what it says it is.
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    # HTTPServer.server_bind resolves its own name (socket.getfqdn), a reverse lookup that on
    # macOS raises the "Allow "Python" to find devices on local networks?" prompt — over the app
    # being photographed. It sat in the middle of the first Mac picture taken on CI (run
    # 37614770864) and threw the shot away; the crossings probe's stub carries this override and
    # this one inherits it.
    def server_bind(self):
        import socketserver
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = "localhost", self.server_address[1]


if __name__ == "__main__":
    # The mode, on the log's own first line and on every line after it: a shots directory that
    # holds two passes' logs can be read without guessing which pass served which row.
    log("stub on :%d recaps=%s args=[%s] pid=%d" % (PORT, "OFF" if RECAPS_OFF else "on",
                                                     " ".join(ARGS), os.getpid()))
    Server(("127.0.0.1", PORT), Handler).serve_forever()
