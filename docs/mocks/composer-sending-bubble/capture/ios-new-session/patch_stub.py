# Turns the claude-region-check probe's stub into this board's new-session one: POST /api/sessions answers 409
# "the machine is offline" for words starting "Archive", never answers (held 45 s, past the app's 20 s) for
# anything else. Each create's body is already logged ("body:") with its clientRequestId.
import sys

path = sys.argv[1]
src = open(path).read()
old = '        self.body()\n        if parts == ["__reset"]:'
assert src.count(old) == 1
src = src.replace(old, '''        posted = self.body()
        if parts == ["api", "sessions"]:
            if str(posted.get("prompt", "")).startswith("Archive"):
                return self.send(409, {"statusCode": 409, "message": "the machine is offline"})
            time.sleep(45)
            try:
                return self.send(201, dict(conversation("S1"), id="S9"))
            except (BrokenPipeError, ConnectionResetError):
                return
        if parts == ["__reset"]:''')
open(path, "w").write(src)
