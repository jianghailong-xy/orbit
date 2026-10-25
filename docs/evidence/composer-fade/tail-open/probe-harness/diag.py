#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the `diag` tree of the probe's matrix is the fix with this
# logging added to TranscriptView, so metrics.log carries every reading the scroll tracker takes, the
# scroll phase, what the tail rules decided and every scroll the transcript asked for — numbered and
# stamped by the app (ProbeMetrics.post). The base and fix trees are photographed untouched.
# Usage: diag.py <tree root>   (edits ConsoleView.swift there, writes DiagLog.swift beside the probe apps)
import os
import sys

root = sys.argv[1]
path = os.path.join(root, "src/macos/OrbitApp/Sources/OrbitApp/Views/Console/ConsoleView.swift")
src = open(path, encoding="utf-8").read()


def edit(anchor, replacement):
    global src
    count = src.count(anchor)
    if count != 1:
        sys.exit("diag: %d matches for %r" % (count, anchor))
    src = src.replace(anchor, replacement)


I = " " * 16  # the tracker's modifier chain
A = " " * 20  # inside its closures

edit(I + ".onScrollPhaseChange { _, phase in\n",
     I + ".onScrollGeometryChange(for: String.self) { DiagLog.geometry($0) } action: { _, line in DiagLog.line(line) }\n"
     + I + ".onScrollPhaseChange { _, phase in\n")

edit(A + "scrolling = phase != .idle\n",
     A + "scrolling = phase != .idle\n"
     + A + 'DiagLog.line("phase \\(phase)")\n')

edit(A + "if TailPinning.followsGeometry(pinned: pinned, from: was, to: now,\n",
     A + 'DiagLog.sample(now, was, "pinned=\\(pinned) scrolling=\\(scrolling) reader=\\(readerIsMoving)")\n'
     + A + "if TailPinning.followsGeometry(pinned: pinned, from: was, to: now,\n")

edit(I + "if TailPinning.followsResize(wasPinned: atBottom, from: was, to: now) { onResize() }\n",
     I + 'DiagLog.line("viewport \\(was) -> \\(now) pinned=\\(atBottom)")\n'
     + I + "if TailPinning.followsResize(wasPinned: atBottom, from: was, to: now) { onResize() }\n")

edit("    private func repinAfterResize() {\n",
     "    private func repinAfterResize() {\n"
     + '        DiagLog.line("repin detached=\\(console.detached) reviewing=\\(reviewingCard)")\n')

edit("        .onChange(of: heldScroll) { _, held in\n",
     "        .onChange(of: heldScroll) { _, held in\n"
     + '            DiagLog.line("held \\(held?.rowID ?? "nil") animated=\\(held?.animated ?? true)")\n')

edit("            let prependAnchor = console.takePrependAnchor()\n",
     "            let prependAnchor = console.takePrependAnchor()\n"
     + '            DiagLog.line("publish rev=\\(console.stateRevision) atBottom=\\(atBottom)")\n')

edit("        if found != stuckID { stuckID = found }\n",
     '        if found != stuckID { DiagLog.line("stuck \\(found ?? "nil")"); stuckID = found }\n')

open(path, "w", encoding="utf-8").write(src)

HELPER = '''import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (diag tree only, written by diag.py): the lines the diag build adds to
// TranscriptView, formatted here so its modifier chains stay cheap for the type-checker.
enum DiagLog {
    @available(iOS 18, macOS 15, *)
    static func geometry(_ geo: ScrollGeometry) -> String {
        String(format: "geo off=%.1f size=%.1f insets=%.1f/%.1f container=%.1f visible=%.1f..%.1f",
               Double(geo.contentOffset.y), Double(geo.contentSize.height), Double(geo.contentInsets.top),
               Double(geo.contentInsets.bottom), Double(geo.containerSize.height),
               Double(geo.visibleRect.minY), Double(geo.visibleRect.maxY))
    }

    @MainActor
    static func sample(_ now: TailScrollSample, _ was: TailScrollSample, _ facts: String) {
        let follow = TailPinning.followsGeometry(pinned: facts.contains("pinned=true"), from: was, to: now,
                                                 moving: facts.contains("scrolling=true") || facts.contains("reader=true"))
        let numbers = String(format: "sample off=%.1f content=%.1f gap=%.1f inset=%.1f <- off=%.1f content=%.1f gap=%.1f inset=%.1f ",
                             now.offset, now.contentHeight, now.bottomGap, now.topInset,
                             was.offset, was.contentHeight, was.bottomGap, was.topInset)
        ProbeMetrics.post("/__scroll", numbers + facts + " follow=\\(follow)")
    }

    @MainActor
    static func line(_ text: String) {
        ProbeMetrics.post("/__scroll", text)
    }
}
'''
for platform in ("ios", "mac"):
    with open(os.path.join(root, ".cfade-probe", platform, "DiagLog.swift"), "w", encoding="utf-8") as f:
        f.write(HELPER)
print("diag: logging added to", path)
