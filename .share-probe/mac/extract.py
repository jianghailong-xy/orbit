#!/usr/bin/env python3
"""TEMPORARY evidence probe: cut ConsoleView's macOS share entry and its sheet out of the real file.

usage: extract.py <ConsoleView.swift> <template> > SessionPageStandIn.swift
"""
import sys

src = open(sys.argv[1], encoding="utf-8").read().split("\n")

# The macOS branch of the console's modifier chain: the lines between the `#else` and `#endif` that
# follow the iOS branch's last modifier.
rename = next(n for n, l in enumerate(src) if ".sessionRenameAlert(isPresented:" in l)
branch = next(n for n in range(rename, len(src)) if src[n].strip() == "#else")
end = next(n for n in range(branch, len(src)) if src[n].strip() == "#endif")
toolbar = src[branch + 1:end]
if not any("ToolbarItem(placement: .primaryAction)" in l for l in toolbar):
    sys.exit("extract.py: the macOS branch holds no .primaryAction toolbar item:\n" + "\n".join(toolbar))

# The sheet: from `.sheet(isPresented: $showShare) {` until its braces balance.
start = next(n for n in range(end, len(src)) if ".sheet(isPresented: $showShare)" in src[n])
depth = 0
for stop in range(start, len(src)):
    depth += src[stop].count("{") - src[stop].count("}")
    if depth == 0:
        break
sheet = src[start:stop + 1]

template = open(sys.argv[2], encoding="utf-8").read()
print(template.replace("{TOOLBAR}", "\n".join(toolbar)).replace("{SHEET}", "\n".join(sheet)), end="")
