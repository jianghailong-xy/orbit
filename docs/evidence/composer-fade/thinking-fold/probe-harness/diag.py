#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): every tree this probe photographs carries this logging
# in TranscriptView, so metrics.log carries the per-frame record the verdict is written from:
# each scroll-geometry change (offset / content height / insets / visible band), each scroll phase
# transition, the pin/follow decision on every reading, every publish and every scroll the
# transcript asks for — numbered and stamped by the app (ProbeMetrics.post), so the lines order
# against the probe's own marks.
# Usage: diag.py <tree root>   (edits ConsoleView.swift there, writes DiagLog.swift beside the
# probe apps under <tree root>/.tfold-probe/{ios,mac}/)
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

edit(A + "ruler.contentOffset = CGFloat(now.offset)\n"
     + A + "recompute()\n"
     + A + "if TailPinning.followsGeometry(pinned: pinned, from: was, to: now,\n"
     + " " * 51 + "moving: scrolling || readerIsMoving) {\n"
     + A + "    follow()\n"
     + A + "}\n",
     A + "ruler.contentOffset = CGFloat(now.offset)\n"
     + A + "recompute()\n"
     + A + 'DiagLog.sample(now, was, "pinned=\\(pinned) atBottom=\\(atBottom) scrolling=\\(scrolling) reader=\\(readerIsMoving)")\n'
     + A + "if TailPinning.followsGeometry(pinned: pinned, from: was, to: now,\n"
     + " " * 51 + "moving: scrolling || readerIsMoving) {\n"
     + A + '    DiagLog.line("follow=true gap=\\(String(format: "%.1f", now.bottomGap))")\n'
     + A + "    follow()\n"
     + A + "}\n")

edit("            let prependAnchor = console.takePrependAnchor()\n",
     "            let prependAnchor = console.takePrependAnchor()\n"
     + '            DiagLog.line("publish rev=\\(console.stateRevision) atBottom=\\(atBottom) detached=\\(console.detached)")\n')

edit("            if atBottom && !console.detached && !reviewingCard {\n"
     + "                proxy.scrollTo(bottomID, anchor: .bottom)\n",
     "            if atBottom && !console.detached && !reviewingCard {\n"
     + '                DiagLog.line("followScrollTo bottom")\n'
     + "                proxy.scrollTo(bottomID, anchor: .bottom)\n")

edit("        guard !console.detached, !reviewingCard else { return }\n"
     + "        #if os(iOS)\n",
     "        guard !console.detached, !reviewingCard else { return }\n"
     + '        DiagLog.line("repinAfterResize")\n'
     + "        #if os(iOS)\n")

edit("    private func holdScroll(to rowID: String, anchor: UnitPoint, opensReview: Bool = false, animated: Bool = true) {\n",
     "    private func holdScroll(to rowID: String, anchor: UnitPoint, opensReview: Bool = false, animated: Bool = true) {\n"
     + '        DiagLog.line("holdScroll \\(rowID) animated=\\(animated)")\n')

edit("        .onChange(of: heldScroll) { _, held in\n"
     + "            guard let held, held.sessionID == console.sessionID else { return }\n",
     "        .onChange(of: heldScroll) { _, held in\n"
     + "            guard let held, held.sessionID == console.sessionID else { return }\n"
     + '            DiagLog.line("held \\(held.rowID) anchor=\\(held.anchor) animated=\\(held.animated)")\n')

open(path, "w", encoding="utf-8").write(src)

HELPER = '''import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (written by diag.py): the lines the diag build adds to
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
        let numbers = String(format: "sample off=%.1f content=%.1f gap=%.1f inset=%.1f <- off=%.1f content=%.1f gap=%.1f inset=%.1f ",
                             now.offset, now.contentHeight, now.bottomGap, now.topInset,
                             was.offset, was.contentHeight, was.bottomGap, was.topInset)
        ProbeMetrics.post("/__scroll", numbers + facts)
    }

    @MainActor
    static func line(_ text: String) {
        ProbeMetrics.post("/__scroll", text)
    }
}
'''
for platform in ("ios", "mac"):
    outdir = os.path.join(root, ".tfold-probe", platform)
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, "DiagLog.swift"), "w", encoding="utf-8") as f:
        f.write(HELPER)
print("diag: logging added to", path)
