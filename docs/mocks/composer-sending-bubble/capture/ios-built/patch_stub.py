# Turns the claude-region-check probe's stub into this board's: S1 at rest after two finished turns, and a send
# that is accepted only after 25 s.
import sys

path = sys.argv[1]
src = open(path).read()


def sub(old, new):
    global src
    assert src.count(old) == 1, old
    src = src.replace(old, new)


start, end = src.index('        ev(4, "user", "t2"'), src.index('    "S2": [')
src = src[:start] + '''        ev(4, "user", "t2", {"text": "Now do the same for the sign-up test."}, ago(3)),
        ev(5, "assistant", "t2", {"text": "Done — the sign-up test now waits on the cookie too, so neither test "
                                          "sleeps on a fixed timer.", "messageId": "m5"}, ago(2)),
        ev(6, "result", "t2", {"subtype": "success", "result": "done"}, ago(2)),
    ],
''' + src[end:]
sub('    held = sid == "S1"\n', '    held = False\n')
sub('"region": {"verdict": "blocked"', '"unused": {"verdict": "blocked"')
sub('        self.body()\n        if parts == ["__reset"]:',
    '''        self.body()
        if parts == ["api", "sessions", "S1", "turns"]:
            time.sleep(25)
            return self.send(201, {"turnId": "t3", "kind": "message", "placement": "accepted"})
        if parts == ["__reset"]:''')
open(path, "w").write(src)
