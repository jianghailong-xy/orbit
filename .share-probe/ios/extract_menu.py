#!/usr/bin/env python3
"""TEMPORARY evidence probe: cut ProjectsView's project menu out of the real file.

usage: extract_menu.py <ProjectsView.swift> <template> > Sources/ProjectPageProbe.swift
"""
import sys

src = open(sys.argv[1], encoding="utf-8").read().split("\n")
start = next(n for n, l in enumerate(src) if "private func menu(" in l)
depth = 0
for stop in range(start, len(src)):
    depth += src[stop].count("{") - src[stop].count("}")
    if depth == 0 and stop > start:
        break
menu = src[start:stop + 1]

template = open(sys.argv[2], encoding="utf-8").read()
print(template.replace("{MENU}", "\n".join(menu)), end="")
