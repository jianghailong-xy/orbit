#!/usr/bin/env python3
"""TEMPORARY evidence probe: cut the real menus, share-status reads and sheets out of the app's own
view files and drop them into the probe pages, so the pictures are of the code the commit ships.

usage: gen.py <repo root> <probe dir>
"""
import sys
from pathlib import Path

root, probe = Path(sys.argv[1]), Path(sys.argv[2])
views = root / "src/macos/OrbitApp/Sources/OrbitApp/Views"


def lines(path):
    return (views / path).read_text(encoding="utf-8").split("\n")


def block(src, start, containing=None, after=0):
    """From the first line at or after `after` holding `start` (and whose block holds `containing`)
    until its braces balance."""
    for first in range(after, len(src)):
        if start not in src[first]:
            continue
        depth = 0
        for stop in range(first, len(src)):
            depth += src[stop].count("{") - src[stop].count("}")
            if depth <= 0 and stop > first:
                break
        cut = src[first:stop + 1]
        if containing is None or any(containing in l for l in cut):
            return "\n".join(cut)
    sys.exit(f"gen.py: no `{start}`" + (f" holding `{containing}`" if containing else ""))


def span(src, start, end, after=0):
    """From the first line at or after `after` holding `start` to the next line holding `end`."""
    first = next(n for n in range(after, len(src)) if start in src[n])
    stop = next(n for n in range(first, len(src)) if end in src[n])
    return "\n".join(src[first:stop + 1])


def render(template, out, **parts):
    text = (probe / template).read_text(encoding="utf-8")
    for key, value in parts.items():
        text = text.replace("{" + key + "}", value)
    (probe / out).write_text(text, encoding="utf-8")
    print(f"==> generated {out}")


projects = lines("ProjectsView.swift")
render("ios/ProjectPageProbe.swift.in", "ios/Sources/ProjectPageProbe.swift",
       MENU=block(projects, "private func menu("),
       READ=block(projects, "private func readShareLink()"),
       SHEET=block(projects, ".sheet(isPresented: $sharing) {"))

tasks = lines("TasksView.swift")
detail = next(n for n, l in enumerate(tasks) if "private struct TaskDetailContent" in l)
toolbar = next(n for n in range(detail, len(tasks)) if ".toolbar {" in tasks[n])
render("ios/TaskPageProbe.swift.in", "ios/Sources/TaskPageProbe.swift",
       MENU=span(tasks, "Menu {", '.accessibilityLabel("Task actions")', after=toolbar),
       READ=block(tasks, ".task(id: taskID) {", containing="shareLink(.task", after=detail),
       SHEET=block(tasks, ".sheet(isPresented: $sharing) {", after=detail))

console = lines("Console/ConsoleView.swift")
render("ios/SessionPageProbe.swift.in", "ios/Sources/SessionPageProbe.swift",
       TOOLBAR_ITEM=block(console, "ToolbarItem(placement: .topBarTrailing) {"),
       SHEET=block(console, ".sheet(isPresented: $showShare) {"))

# The Mac session page: its window-toolbar item (the `#else` branch after the iOS chain's last
# modifier) and the sheet both platforms present.
rename = next(n for n, l in enumerate(console) if ".sessionRenameAlert(isPresented:" in l)
branch = next(n for n in range(rename, len(console)) if console[n].strip() == "#else")
end = next(n for n in range(branch, len(console)) if console[n].strip() == "#endif")
mac_toolbar = "\n".join(console[branch + 1:end])
if "ToolbarItem(placement: .primaryAction)" not in mac_toolbar:
    sys.exit("gen.py: the macOS branch holds no .primaryAction toolbar item:\n" + mac_toolbar)
render("mac/SessionPageStandIn.swift.in", "mac/Sources/ShareProbe/SessionPageStandIn.swift",
       TOOLBAR=mac_toolbar, SHEET=block(console, ".sheet(isPresented: $showShare) {"))
