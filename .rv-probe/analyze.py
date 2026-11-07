#!/usr/bin/env python3
# TEMPORARY probe analysis (never merged), task 34tKCNy9aN3Itk5SgIoIl. For each trial in <shots>/trials.log: the
# decide's answer and the app's next request (from the stub's requests.log), and what the app's StallWatch saw in its
# window: how late the main queue got, every STALL it logged, whether the watchdog itself was HELD, and the main
# thread's commonest stack while it was late. Writes <shots>/analysis.txt and analysis.json. With --prune, deletes
# the host capture's frames and video of every trial whose gap was under 3 s (their times.json stays).
# Usage: analyze.py <shots dir> [--prune]
import collections
import glob
import json
import os
import re
import shutil
import sys

SHOTS = sys.argv[1]
PRUNE = "--prune" in sys.argv[2:]
STAMP = re.compile(r"\[(\d{13})\]")


def read(path):
    try:
        with open(path, errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def decides():
    out = []
    current = None
    for line in read(os.path.join(SHOTS, "requests.log")).splitlines():
        m = STAMP.search(line)
        if not m:
            continue
        stamp = int(m.group(1))
        access = not line.startswith("    ")
        if access and '"POST /api/wiki/changesets/' in line and "/decide " in line:
            current = {"answered": stamp}
            out.append(current)
            continue
        if current is not None and access and "/__reset" not in line:
            current["next"] = stamp
            current["nextLine"] = line.strip()[:120]
            current["gap"] = (stamp - current["answered"]) / 1000.0
            current = None
    return out


def trials():
    out = []
    for line in read(os.path.join(SHOTS, "trials.log")).splitlines():
        parts = line.split()
        if not parts:
            continue
        row = {"trial": parts[0]}
        for part in parts[1:]:
            if "=" in part:
                key, value = part.split("=", 1)
                row[key] = value
        out.append(row)
    return out


def watch(trial, t0):
    """What the app's StallWatch logged for this trial from just before the tap to 22 s after it."""
    text = read(os.path.join(SHOTS, "stallwatch-%s.log" % trial))
    if not text:
        return {"log": False}
    entries = []  # (wall ms, first line, rest)
    for block in re.split(r"\n(?=\d{13} )", text):
        head, _, rest = block.partition("\n")
        m = re.match(r"(\d{13}) (.*)", head)
        if m:
            entries.append((int(m.group(1)), m.group(2), rest))
    start, end = t0 - 500, t0 + 22000
    seen = {"log": True, "maxLate": 0, "stalls": [], "held": [], "window": False}
    stacks = collections.Counter()
    current = None
    for at, head, rest in entries:
        if head.startswith("WINDOW OPEN"):
            if start <= at <= end:
                seen["window"] = True
        if not (start <= at <= end):
            continue
        m = re.search(r"late=(\d+)", head)
        if m:
            seen["maxLate"] = max(seen["maxLate"], int(m.group(1)))
        if head.startswith("STALL BEGIN") or head.startswith("STALL END"):
            seen["stalls"].append("+%d ms %s" % (at - t0, head))
        if head.startswith("HELD"):
            seen["held"].append("+%d ms %s" % (at - t0, head))
        if head.startswith("MAIN-STALL") or head.startswith("MAIN "):
            late = int(m.group(1)) if m else 0
            if rest:
                current = "\n".join(rest.splitlines()[:28])
            if late > 1000 and current:
                stacks[current] += 1
    if stacks:
        stack, count = stacks.most_common(1)[0]
        seen["stackWhileLate"] = {"samples": count, "of": sum(stacks.values()), "stack": stack}
    return seen


def main():
    rows = []
    for trial in trials():
        t0 = int(trial.get("t0") or 0)
        row = dict(trial)
        if t0:
            row["watch"] = watch(trial["trial"], t0)
        rows.append(row)
    lines = ["trial                     capture dialog  tap ms   gap s  main late max  watchdog held  stall?"]
    for row in rows:
        w = row.get("watch", {})
        lines.append("%-25s %-7s %-6s %7s %7s %13s %14s  %s" % (
            row["trial"], row.get("capture", "?"), row.get("dialog", "?"), row.get("tapMs", "?"), row.get("gap", "?"),
            "%d ms" % w.get("maxLate", 0) if w.get("log") else "(no log)", len(w.get("held", [])),
            "STALL" if row.get("gap", "0") not in ("?",) and float(row["gap"]) > 3 else ""))
    by_mode = collections.defaultdict(list)
    for row in rows:
        if row.get("gap", "?") != "?":
            by_mode[(row.get("capture"), row.get("dialog"))].append(float(row["gap"]))
    lines.append("")
    for (capture, dialog), gaps in sorted(by_mode.items()):
        stalls = sum(1 for g in gaps if g > 3)
        lines.append("capture %-3s dialog %-5s: %2d presses, %d over 3 s, gaps %s" % (
            capture, dialog, len(gaps), stalls, " ".join("%.2f" % g for g in sorted(gaps))))
    for row in rows:
        w = row.get("watch", {})
        if w.get("stalls") or w.get("held") or w.get("stackWhileLate"):
            lines.append("")
            lines.append("== %s (gap %s s)" % (row["trial"], row.get("gap")))
            lines.extend("  " + s for s in w.get("stalls", []))
            lines.extend("  " + s for s in w.get("held", []))
            if w.get("stackWhileLate"):
                s = w["stackWhileLate"]
                lines.append("  main thread's commonest stack while more than 1 s late (%d of %d samples):"
                             % (s["samples"], s["of"]))
                lines.append(s["stack"])
    lines.append("")
    lines.append("every decide in requests.log (answer -> the app's next request):")
    for d in decides():
        lines.append("  %d gap %s s  %s" % (d["answered"], d.get("gap", "?"), d.get("nextLine", "(none)")))
    with open(os.path.join(SHOTS, "analysis.txt"), "w") as f:
        f.write("\n".join(lines) + "\n")
    with open(os.path.join(SHOTS, "analysis.json"), "w") as f:
        json.dump({"trials": rows, "decides": decides()}, f, indent=1)
    print("\n".join(lines[:60]))
    if PRUNE:
        for row in rows:
            name = row["trial"]
            frames = sorted(glob.glob(os.path.join(SHOTS, "frames-%s" % name, "*.png")))
            if row.get("gap", "?") != "?" and float(row["gap"]) <= 3:
                for png in frames:
                    os.remove(png)
                video = os.path.join(SHOTS, "video-%s.mp4" % name)
                if os.path.exists(video):
                    os.remove(video)
            else:
                # A stalled trial keeps every third frame of the host's capture (times.json names them all).
                for index, png in enumerate(frames):
                    if index % 3:
                        os.remove(png)


if __name__ == "__main__":
    main()
