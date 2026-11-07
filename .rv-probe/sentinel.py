#!/usr/bin/env python3
# TEMPORARY probe instrument (never merged), task 34tKCNy9aN3Itk5SgIoIl: the host's view of a stall. It follows the
# stub's requests.log during the iPhone pass. Once a decide (POST .../decide) has been answered and the app has sent
# nothing for 2 s, it records, for that stall k:
#   ps-<k>.log       the app process's state every 250 ms (ps: stat, %cpu, cputime, wchan) until its next request,
#                    with the simulator's other busy processes (top 8 by CPU) once a second;
#   top-<k>.txt      one `top` of the host;
#   spindump-<k>.txt a spindump of the app (sudo; `sample` if sudo is refused), started at once and left to finish.
# Every decide's gap (answer to the app's next request) goes to sentinel.json at the end.
# Usage: sentinel.py <shots dir>; stops once <shots dir>/.pass-done exists and its spindumps have finished.
import json
import os
import re
import subprocess
import sys
import threading
import time

SHOTS = sys.argv[1]
LOG = os.path.join(SHOTS, "requests.log")
FIRE_AFTER = 2000  # ms
STAMP = re.compile(r"\[(\d{13})\]")


def ms():
    return int(time.time() * 1000)


def say(text):
    with open(os.path.join(SHOTS, "sentinel.log"), "a") as f:
        f.write("%d %s\n" % (ms(), text))


def app_pid():
    out = subprocess.run(["pgrep", "-n", "-f", "RvProbe.app/RvProbe"], capture_output=True, text=True).stdout.strip()
    return out or None


def watch_process(k, pid, stall):
    """ps of the app every 250 ms until the stall ends (+2 s) or 40 s pass; the busiest processes once a second."""
    path = os.path.join(SHOTS, "ps-%d.log" % k)
    started = ms()
    last_top = 0
    with open(path, "a") as f:
        while ms() - started < 40000:
            if stall.get("ended") and ms() - stall["ended"] > 2000:
                break
            row = subprocess.run(["ps", "-o", "pid=,stat=,pcpu=,cputime=,wchan=", "-p", pid],
                                 capture_output=True, text=True).stdout.strip()
            f.write("%d app %s\n" % (ms(), row or "(gone)"))
            if ms() - last_top >= 1000:
                last_top = ms()
                top = subprocess.run(["ps", "-A", "-r", "-o", "pid=,stat=,pcpu=,comm="], capture_output=True,
                                     text=True).stdout.splitlines()[:8]
                for line in top:
                    f.write("%d busy %s\n" % (ms(), line.strip()))
            f.flush()
            time.sleep(0.25)


def fire(k, stall, children):
    pid = app_pid()
    say("stall %d: decide answered at %d, nothing from the app for %d ms; app pid %s"
        % (k, stall["answered"], ms() - stall["answered"], pid))
    stall["pid"] = pid
    stall["fired"] = ms()
    if not pid:
        return
    threading.Thread(target=watch_process, args=(k, pid, stall), daemon=True).start()
    top = open(os.path.join(SHOTS, "top-%d.txt" % k), "w")
    children.append(subprocess.Popen(["top", "-l", "2", "-s", "1", "-n", "20", "-o", "cpu",
                                      "-stats", "pid,command,cpu,state,time,threads"],
                                     stdout=top, stderr=subprocess.STDOUT))
    dump = os.path.join(SHOTS, "spindump-%d.txt" % k)
    out = open(os.path.join(SHOTS, "spindump-%d.out" % k), "w")
    if subprocess.run(["sudo", "-n", "true"], capture_output=True).returncode == 0:
        command = ["sudo", "-n", "spindump", pid, "4", "10", "-file", dump]
    else:
        command = ["sample", pid, "4", "-file", dump.replace("spindump", "sample")]
    say("stall %d: %s" % (k, " ".join(command)))
    stall["dump"] = command
    children.append(subprocess.Popen(command, stdout=out, stderr=subprocess.STDOUT))


def main():
    say("following %s" % LOG)
    offset = 0
    pending = ""
    decides = []
    current = None
    children = []
    while not os.path.exists(os.path.join(SHOTS, ".pass-done")):
        try:
            with open(LOG, errors="replace") as f:
                f.seek(offset)
                chunk = f.read()
                offset = f.tell()
        except OSError:
            chunk = ""
        pending += chunk
        *lines, pending = pending.split("\n")
        for line in lines:
            m = STAMP.search(line)
            if not m:
                continue
            stamp = int(m.group(1))
            access = not line.startswith("    ")
            if access and '"POST /api/wiki/changesets/' in line and "/decide " in line:
                current = {"answered": stamp, "line": line.strip()}
                decides.append(current)
                continue
            if current is not None and access and "/__reset" not in line:
                current["next"] = stamp
                current["nextLine"] = line.strip()
                current["gap"] = (stamp - current["answered"]) / 1000.0
                if current.get("fired"):
                    current["ended"] = ms()
                    say("stall %d ended: the app's next request at %d (gap %.3f s): %s"
                        % (decides.index(current) + 1, stamp, current["gap"], line.strip()))
                current = None
        if current is not None and not current.get("fired") and ms() - current["answered"] > FIRE_AFTER:
            fire(len(decides), current, children)
        time.sleep(0.1)
    say("pass done; waiting for %d child process(es)" % len(children))
    deadline = time.time() + 240
    for child in children:
        try:
            child.wait(timeout=max(1, deadline - time.time()))
        except subprocess.TimeoutExpired:
            say("killing %s after the deadline" % child.args)
            child.kill()
    subprocess.run(["sudo", "-n", "chmod", "-R", "a+r", SHOTS], capture_output=True)
    with open(os.path.join(SHOTS, "sentinel.json"), "w") as f:
        json.dump(decides, f, indent=1)
    say("wrote sentinel.json: %d decides" % len(decides))


if __name__ == "__main__":
    main()
