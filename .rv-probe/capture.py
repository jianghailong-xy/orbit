#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): frames of the iPhone simulator's screen around a press, taken from the
# host so that nothing waits for the app to go idle (XCUITest's own tap() returns only once it has). The UI test drops
# SHOTS/capture-<name>.req; this records the screen for SECONDS seconds as a video (simctl io recordVideo) and, beside
# it, as a loop of simctl screenshots, each stamped with the host clock (epoch ms) before and after the call, then
# drops capture-<name>.done. stub.py stamps the decide POST with the same clock, so a frame's time after the tap is
# its stamp minus the POST's; 1.5 s after that POST it samples the app's threads. Before any request it warms both
# simctl io doors up (their first use froze the simulator in run 42335927712).
# Usage: capture.py <udid> <shots dir>; stops once <shots dir>/.pass-done exists.
import json
import os
import signal
import subprocess
import sys
import threading
import time

UDID, SHOTS = sys.argv[1], sys.argv[2]
SECONDS = float(os.environ.get("CAPTURE_SECONDS", "11"))
GAP = 0.2  # at most five frames a second


def ms():
    return int(time.time() * 1000)


def say(line):
    with open(os.path.join(SHOTS, "capture.log"), "a") as f:
        f.write("%d %s\n" % (ms(), line))


def decide_posted(after):
    """The epoch ms at which the stub logged a decide POST, the first one after `after`; None before one."""
    try:
        with open(os.path.join(SHOTS, "requests.log"), errors="replace") as f:
            for line in f:
                if "/decide body:" in line:
                    stamp = int(line.split("[", 1)[1].split("]", 1)[0])
                    if stamp > after:
                        return stamp
    except (OSError, ValueError, IndexError):
        return None
    return None


def sample_after_decide(name, asked):
    """1.5 s after the decide reached the stub, three seconds of the app's threads (sample(1)): an app that answers
    at once is idle there, and one that froze shows what it waits on. None until then, False if it could not start.
    CAPTURE_SAMPLE=0 (task 34tKCNy9aN3Itk5SgIoIl) leaves the sampling to sentinel.py, the same with or without a capture."""
    if os.environ.get("CAPTURE_SAMPLE", "1") == "0":
        return False
    posted = decide_posted(asked)
    if posted is None or ms() < posted + 1500:
        return None
    pid = subprocess.run(["pgrep", "-n", "-f", "RvProbe.app/RvProbe"], capture_output=True, text=True).stdout.strip()
    if not pid:
        say("%s: no app process to sample" % name)
        return False
    path = os.path.join(SHOTS, "sample-%s.txt" % name)
    say("%s: sampling app pid %s at +%d ms after the decide" % (name, pid, ms() - posted))
    try:
        return subprocess.Popen(["sample", pid, "3", "-file", path], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    except OSError as error:
        say("%s: sample failed: %r" % (name, error))
        return False


def warm_up():
    """The first simctl io screenshot and recordVideo of a fresh simulator took 7 s and 13 s (run 42335927712),
    and the app froze across them: take both once now, while the apps build, so the presses find them warm."""
    path = os.path.join(SHOTS, "warmup.png")
    t0 = ms()
    done = subprocess.run(["xcrun", "simctl", "io", UDID, "screenshot", "--type=png", path], capture_output=True, text=True)
    say("warm-up screenshot: rc %s in %d ms" % (done.returncode, ms() - t0))
    video = os.path.join(SHOTS, "video-warmup.mp4")
    t0 = ms()
    rec = subprocess.Popen(["xcrun", "simctl", "io", UDID, "recordVideo", "--codec=h264", "--force", video],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    lines = []

    def read():
        for line in rec.stdout:
            lines.append([ms(), line.rstrip()])

    threading.Thread(target=read, daemon=True).start()
    deadline = time.time() + 40
    while time.time() < deadline and not any("start" in line.lower() for _, line in lines) and rec.poll() is None:
        time.sleep(0.05)
    started = next((at for at, line in lines if "start" in line.lower()), None)
    say("warm-up video: recording after %s ms" % (started - t0 if started else "never"))
    time.sleep(3)
    rec.send_signal(signal.SIGINT)
    try:
        rec.wait(timeout=30)
    except subprocess.TimeoutExpired:
        rec.kill()
    for k in range(3):
        t0 = ms()
        done = subprocess.run(["xcrun", "simctl", "io", UDID, "screenshot", "--type=png", path], capture_output=True,
                              text=True)
        say("warm-up screenshot %d: rc %s in %d ms" % (k + 2, done.returncode, ms() - t0))


def capture(name):
    out = os.path.join(SHOTS, "frames-" + name)
    os.makedirs(out, exist_ok=True)
    video = os.path.join(SHOTS, "video-%s.mp4" % name)
    lines = []
    asked = ms()
    rec = subprocess.Popen(["xcrun", "simctl", "io", UDID, "recordVideo", "--codec=h264", "--force", video],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    def read():
        for line in rec.stdout:
            lines.append([ms(), line.rstrip()])

    threading.Thread(target=read, daemon=True).start()
    deadline = time.time() + 15
    while time.time() < deadline and not any("start" in line.lower() for _, line in lines) and rec.poll() is None:
        time.sleep(0.02)
    say("%s: video %s (%s)" % (name, "recording" if rec.poll() is None else "exited %s" % rec.returncode, lines[-1:]))
    with open(os.path.join(SHOTS, "capture-%s.started" % name), "w") as f:
        f.write(str(ms()))
    frames = []
    end = time.time() + SECONDS
    i = 0
    sampler = None
    while time.time() < end:
        if sampler is None:
            sampler = sample_after_decide(name, asked)
        t0 = ms()
        path = os.path.join(out, "f%03d.png" % i)
        done = subprocess.run(["xcrun", "simctl", "io", UDID, "screenshot", "--type=png", path],
                              capture_output=True, text=True)
        t1 = ms()
        frames.append({"i": i, "file": os.path.basename(path), "start": t0, "end": t1, "rc": done.returncode,
                       "err": (done.stderr or "").strip()[-300:]})
        i += 1
        rest = GAP - (time.time() - t0 / 1000)
        if rest > 0:
            time.sleep(rest)
    stopped = ms()
    if sampler not in (None, False):
        try:
            sampler.wait(timeout=20)
        except subprocess.TimeoutExpired:
            sampler.kill()
    if rec.poll() is None:
        rec.send_signal(signal.SIGINT)
        try:
            rec.wait(timeout=30)
        except subprocess.TimeoutExpired:
            rec.kill()
    with open(os.path.join(out, "times.json"), "w") as f:
        json.dump({"name": name, "udid": UDID, "videoAsked": asked, "videoLines": lines, "videoStopAsked": stopped,
                   "videoExit": rec.returncode, "frames": frames}, f, indent=1)
    say("%s: %d frames, video exit %s, %d bytes" % (name, len(frames), rec.returncode,
                                                   os.path.getsize(video) if os.path.exists(video) else -1))
    with open(os.path.join(SHOTS, "capture-%s.done" % name), "w") as f:
        f.write(str(ms()))


def main():
    try:
        warm_up()
    except Exception as error:
        say("warm-up failed: %r" % (error,))
    say("watching %s for capture requests (udid %s)" % (SHOTS, UDID))
    while not os.path.exists(os.path.join(SHOTS, ".pass-done")):
        asked = sorted(f for f in os.listdir(SHOTS) if f.startswith("capture-") and f.endswith(".req"))
        if not asked:
            time.sleep(0.05)
            continue
        req = asked[0]
        os.rename(os.path.join(SHOTS, req), os.path.join(SHOTS, req + ".taken"))
        name = req[len("capture-"):-len(".req")]
        say("request %s" % name)
        try:
            capture(name)
        except Exception as error:  # a failed capture must not leave the test waiting
            say("%s failed: %r" % (name, error))
            with open(os.path.join(SHOTS, "capture-%s.done" % name), "w") as f:
                f.write("failed %r" % (error,))
    say("pass done")


if __name__ == "__main__":
    main()
