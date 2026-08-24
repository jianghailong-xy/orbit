import XCTest
@testable import OrbitKit

// Measurement harness behind docs/ios-perf-baseline.md.
//
// It is a *test* only so it can reuse OrbitKit's build and run on Linux (`swift test`), which is
// where the transcript pieces the iOS optimisation work targets actually live — the reducer, the
// snapshot store, the row builder and the Markdown parser are all UI-free. It is SKIPPED unless
// `ORBIT_PERF=1` is set, so CI never pays for it:
//
//   docker run --rm -e ORBIT_PERF=1 -v "$PWD:/src" -w /src/src/macos/OrbitKit swift:6.1 \
//     swift test --filter PerfBaselineTests
//
// The synthetic transcript below is calibrated to a real session in the production database
// (event-type mix and per-type payload-size percentiles — see the doc's "conditions" section);
// only the *words* are generated, because the shapes and sizes are what encoding, row building
// and Markdown parsing cost. Everything is seeded, so two runs produce the same numbers and a
// follow-up task can compare before/after.
final class PerfBaselineTests: XCTestCase {

    private func skipUnlessEnabled() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["ORBIT_PERF"] == "1",
                          "perf baseline harness — set ORBIT_PERF=1 to run")
    }

    // MARK: - deterministic corpus

    /// Seeded LCG: same numbers on every run, on every machine.
    private struct RNG {
        private var s: UInt64
        init(seed: UInt64) { s = seed }
        mutating func next() -> UInt64 { s = s &* 6364136223846793005 &+ 1442695040888963407; return s }
        mutating func int(_ range: ClosedRange<Int>) -> Int {
            range.lowerBound + Int(next() >> 33) % (range.count)
        }
        /// Pick a length from a p50/p90/p99 profile measured in production.
        mutating func length(p50: Int, p90: Int, p99: Int, max: Int) -> Int {
            switch int(0...99) {
            case 0..<50:  return int(1...p50)
            case 50..<90: return int(p50...p90)
            case 90..<99: return int(p90...p99)
            default:      return int(p99...max)
            }
        }
    }

    private static let words = ["the", "runner", "session", "transcript", "reducer", "seq", "commit",
                                "worktree", "approval", "payload", "snapshot", "console", "poll",
                                "merge", "branch", "event", "stream", "cursor", "token", "cache"]

    /// Markdown-shaped prose of roughly `target` characters: paragraphs, a bullet list, a fenced
    /// code block and (occasionally) a GFM table — the constructs the renderer actually parses.
    private static func markdown(_ target: Int, _ rng: inout RNG) -> String {
        var out = ""
        var written = 0
        var kind = 0
        func add(_ s: String) { out += s; written += s.utf8.count }
        while written < target {
            switch kind % 4 {
            case 0:
                add("## " + words[rng.int(0...words.count - 1)].capitalized + "\n\n")
            case 1:
                var p = ""
                var n = 0
                while n < 180 { let w = words[rng.int(0...words.count - 1)] + " "; p += w; n += w.utf8.count }
                add(p + "`inline` and **bold** text.\n\n")
            case 2:
                for i in 0..<3 { add("- item \(i): " + words[rng.int(0...words.count - 1)] + "\n") }
                add("\n")
            default:
                add("```swift\nlet x = \(rng.int(0...9999))\nprint(x)\n```\n\n")
            }
            kind += 1
        }
        return String(out.prefix(target))
    }

    private static func obj(_ pairs: [String: JSONValue]) -> JSONValue { .object(pairs) }

    /// One synthetic session whose event mix matches production session 01a00ea9 (8,519 renderable
    /// events: 46.2% tool_use, 46.2% tool_result, 6.3% assistant, 0.67% user, 0.66% turn_end).
    /// `tool_result` content is clipped at 2048 chars, exactly as the server does for the client's
    /// `maxPayload=2048` request.
    private static func makeEvents(_ count: Int, seed: UInt64 = 42) -> [RunEvent] {
        var rng = RNG(seed: seed)
        var events: [RunEvent] = []
        events.reserveCapacity(count)
        var seq = 1
        var turn = 0
        while events.count < count {
            turn += 1
            let ts = "2026-08-20T10:\(String(format: "%02d", turn % 60)):00.000Z"
            let turnID = "turn-\(turn)"
            // user
            events.append(RunEvent(seq: seq, type: .user, ts: ts, turnId: turnID,
                                   payload: obj(["text": .string(markdown(rng.length(p50: 701, p90: 1587, p99: 2849, max: 15189), &rng))])))
            seq += 1
            // ~69 tool pairs + ~9 assistant messages per turn (the measured ratio)
            for i in 0..<69 where events.count < count {
                let id = "tu-\(turn)-\(i)"
                let name = ["Bash", "Read", "Edit", "Grep", "Write"][rng.int(0...4)]
                events.append(RunEvent(seq: seq, type: .toolUse, ts: ts, turnId: turnID,
                                       payload: obj(["toolUseId": .string(id), "name": .string(name),
                                                     "input": obj(["command": .string(markdown(rng.length(p50: 120, p90: 250, p99: 900, max: 3000), &rng))])])))
                seq += 1
                guard events.count < count else { break }
                let body = markdown(rng.length(p50: 1045, p90: 5191, p99: 20000, max: 79886), &rng)
                events.append(RunEvent(seq: seq, type: .toolResult, ts: ts, turnId: turnID,
                                       payload: obj(["toolUseId": .string(id), "content": .string(String(body.prefix(2048)))]),
                                       truncated: body.count > 2048))
                seq += 1
                if i % 8 == 7, events.count < count {
                    events.append(RunEvent(seq: seq, type: .assistant, ts: ts, turnId: turnID,
                                           payload: obj(["text": .string(markdown(rng.length(p50: 43, p90: 104, p99: 831, max: 11676), &rng))])))
                    seq += 1
                }
            }
            if events.count < count {
                events.append(RunEvent(seq: seq, type: .turnEnd, ts: ts, turnId: turnID,
                                       payload: obj(["contextTokens": .int(rng.int(1000...180000)), "contextWindow": .int(200000)])))
                seq += 1
            }
        }
        return Array(events.prefix(count))
    }

    // MARK: - helpers

    /// The shipped in-memory window cap, mirrored from `ConsoleModel.maxWindowItems` /
    /// `windowTrimSlack` (OrbitApp can't be imported here — it's SwiftUI/Apple-only). The `capped`
    /// rows below are what the app actually holds after the cap landed; the uncapped rows next to
    /// them are the pre-cap baseline the doc's §6/§7 tables were measured from, kept in the same
    /// run so before/after is same-machine by construction.
    private static let windowMaxItems = 1000
    private static let windowSlack = 200

    /// A copy of `r` trimmed the way a console pinned at the live tail trims itself.
    private func capped(_ r: TranscriptReducer) -> TranscriptReducer {
        var t = r
        t.trimOlder(keeping: Self.windowMaxItems, slack: Self.windowSlack)
        return t
    }

    private func median(_ xs: [Double]) -> Double { xs.sorted()[xs.count / 2] }

    private func timeIt(_ reps: Int, _ body: () -> Void) -> Double {
        var samples: [Double] = []
        for _ in 0..<reps {
            let t0 = DispatchTime.now().uptimeNanoseconds
            body()
            samples.append(Double(DispatchTime.now().uptimeNanoseconds - t0) / 1_000_000)
        }
        return median(samples)
    }

    /// A /proc/self/status size field in MB. Linux-only (the harness's host).
    private func procMB(_ field: String) -> Double {
        guard let status = try? String(contentsOfFile: "/proc/self/status", encoding: .utf8) else { return -1 }
        for line in status.split(separator: "\n") where line.hasPrefix(field + ":") {
            let kb = line.split(whereSeparator: { $0 == " " || $0 == "\t" }).dropFirst().first.flatMap { Double($0) } ?? 0
            return kb / 1024
        }
        return -1
    }
    private func rssMB() -> Double { procMB("VmRSS") }
    private func peakRssMB() -> Double { procMB("VmHWM") }

    private func report(_ line: String) { print("PERF| " + line) }

    // MARK: - 1. snapshot write amplification (ConsoleRegistry.persist → FileTranscriptStore.save)

    func testSnapshotWriteAmplification() throws {
        try skipUnlessEnabled()
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("perf-\(UUID().uuidString)")
        let store = FileTranscriptStore(directory: dir)
        defer { try? FileManager.default.removeItem(at: dir) }

        // Two ways a console reaches N events, because they leave the reducer in different shapes:
        //  • "opened"  — one tail page (what opening a session costs)
        //  • "watched" — every event applied one at a time (what watching a session run costs; this
        //    is the path that grows `seen`, one Int per durable seq, for the console's whole life)
        for n in [200, 1000, 2000, 8519] {
            let events = Self.makeEvents(n)

            var opened = TranscriptReducer()
            opened.applyTailPage(EventPage(events: events, hasMore: true))

            var watched = TranscriptReducer()
            for e in events { watched.apply(e) }

            for (label, reducer) in [("opened", opened), ("watched", watched),
                                     ("capped", capped(watched))] {
                let encoded = try JSONEncoder().encode(reducer)
                let encodeMs = timeIt(5) { _ = try? JSONEncoder().encode(reducer) }
                let saveMs = timeIt(5) { store.save(sessionID: "s-\(label)-\(n)", reducer: reducer) }
                let path = dir.appendingPathComponent("s-\(label)-\(n).json")
                let attrs = try? FileManager.default.attributesOfItem(atPath: path.path)
                let fileBytes = (attrs?[.size] as? Int) ?? 0
                let loadMs = timeIt(5) { _ = store.load(sessionID: "s-\(label)-\(n)") }

                // How much of the snapshot is the unbounded `seen` set of seqs.
                // `encoded` is the reducer itself; `save` wraps it in a 24-byte version envelope.
                var seenBytes = 0
                if let root = try? JSONSerialization.jsonObject(with: encoded) as? [String: Any],
                   let seen = root["seen"] as? [Int] {
                    seenBytes = (try? JSONSerialization.data(withJSONObject: seen)).map { $0.count } ?? 0
                }
                report(String(format: "snapshot events=%d shape=%@ items=%d encoded_bytes=%d encode_ms=%.1f save_ms=%.1f load_ms=%.1f file_bytes=%d seen_bytes=%d seen_pct=%.1f",
                              n, label, reducer.state.items.count, encoded.count, encodeMs, saveMs, loadMs,
                              fileBytes, seenBytes,
                              fileBytes > 0 ? Double(seenBytes) * 100 / Double(fileBytes) : 0))
            }
        }
    }

    // MARK: - 2. TranscriptRows.build

    func testRowsBuild() throws {
        try skipUnlessEnabled()
        for n in [200, 1000, 2000, 8519] {
            var reducer = TranscriptReducer()
            reducer.applyTailPage(EventPage(events: Self.makeEvents(n), hasMore: true))
            for (label, state) in [("uncapped", reducer.state), ("capped", capped(reducer).state)] {
                var rows = 0
                let ms = timeIt(20) {
                    rows = TranscriptRows.build(state: state, statusCards: [], canPageOlder: true,
                                                showWorkingIndicator: true).count
                }
                report(String(format: "rowsbuild events=%d window=%@ items=%d rows=%d ms=%.2f",
                              n, label, state.items.count, rows, ms))
            }
        }
    }

    // MARK: - 3. Markdown parsing

    func testMarkdownParse() throws {
        try skipUnlessEnabled()
        var reducer = TranscriptReducer()
        reducer.applyTailPage(EventPage(events: Self.makeEvents(8519), hasMore: true))
        // Every string the transcript renders through the Markdown parser: assistant + user bubbles.
        var texts: [String] = []
        for item in reducer.state.items {
            switch item {
            case .assistant(let b): texts.append(b.text)
            case .user(let b): texts.append(b.text)
            default: break
            }
        }
        let chars = texts.reduce(0) { $0 + $1.count }
        var blocks = 0
        let ms = timeIt(5) { blocks = texts.reduce(0) { $0 + parseMarkdownBlocks($1).count } }
        report(String(format: "markdown messages=%d chars=%d blocks=%d total_ms=%.1f per_msg_us=%.1f per_kchar_us=%.1f",
                      texts.count, chars, blocks, ms, ms * 1000 / Double(texts.count),
                      ms * 1000 / (Double(chars) / 1000)))

        // The streaming split runs on every delta, over the whole open block.
        var splitRNG = RNG(seed: 7)
        let long = Self.markdown(4000, &splitRNG)
        let splitMs = timeIt(50) { _ = splitStreamingMarkdown(long) }
        report(String(format: "markdown_split chars=%d ms=%.3f", long.count, splitMs))
    }

    // MARK: - 4. one streaming turn, main-thread cost per delta

    func testStreamingTurnMainThreadCost() throws {
        try skipUnlessEnabled()
        // Two windows, because the cost is linear in the window and the cap is about the second one:
        //  • 1,000 events — a freshly opened session (the original baseline row);
        //  • 8,519 events — the sampled long session watched all the way through, which is the shape
        //    that used to have no ceiling at all. `capped` is what the app holds there now.
        for (events, cap) in [(1000, false), (8519, false), (8519, true)] {
            var reducer = TranscriptReducer()
            reducer.applyTailPage(EventPage(events: Self.makeEvents(events), hasMore: true))
            if cap { reducer = capped(reducer) }
            streamOneTurn(into: &reducer, window: events, capped: cap)
        }
    }

    /// 200 `text_delta`s through the three things a streaming frame does on the main thread.
    private func streamOneTurn(into reducer: inout TranscriptReducer, window: Int, capped cap: Bool) {
        var rng = RNG(seed: 11)
        let deltas = (0..<200).map { _ in Self.words[rng.int(0...Self.words.count - 1)] + " " }

        var applyMs = 0.0, rowsMs = 0.0, mdMs = 0.0
        var open = ""
        for d in deltas {
            open += d
            var t0 = DispatchTime.now().uptimeNanoseconds
            reducer.apply(RunEvent(seq: 0, type: .textDelta, payload: Self.obj(["delta": .string(d)])))
            applyMs += Double(DispatchTime.now().uptimeNanoseconds - t0) / 1_000_000

            let state = reducer.state
            t0 = DispatchTime.now().uptimeNanoseconds
            _ = TranscriptRows.build(state: state, statusCards: [], canPageOlder: true, showWorkingIndicator: true)
            rowsMs += Double(DispatchTime.now().uptimeNanoseconds - t0) / 1_000_000

            t0 = DispatchTime.now().uptimeNanoseconds
            let (stable, _) = splitStreamingMarkdown(open)
            _ = parseMarkdownBlocks(String(stable))
            mdMs += Double(DispatchTime.now().uptimeNanoseconds - t0) / 1_000_000
        }
        report(String(format: "streaming events=%d window=%@ deltas=%d window_items=%d apply_ms=%.1f rowsbuild_ms=%.1f markdown_ms=%.1f total_ms=%.1f per_delta_ms=%.2f",
                      window, cap ? "capped" : "uncapped", deltas.count, reducer.state.items.count,
                      applyMs, rowsMs, mdMs,
                      applyMs + rowsMs + mdMs, (applyMs + rowsMs + mdMs) / Double(deltas.count)))
    }

    // MARK: - 5. resident memory held by cached consoles

    func testResidentMemoryOfCachedConsoles() throws {
        try skipUnlessEnabled()
        let base = rssMB()
        report(String(format: "memory stage=baseline rss_mb=%.1f peak_mb=%.1f", base, peakRssMB()))
        var held: [TranscriptReducer] = []
        var snapshotBytes = 0
        // ConsoleRegistry's LRU capacity is 12 — the worst case a phone can be holding.
        for i in 1...12 {
            var r = TranscriptReducer()
            r.applyTailPage(EventPage(events: Self.makeEvents(1000, seed: UInt64(100 + i)), hasMore: true))
            snapshotBytes += ((try? JSONEncoder().encode(r))?.count ?? 0)
            held.append(r)
            if [1, 5, 12].contains(i) {
                report(String(format: "memory stage=consoles_%d items=%d encoded_bytes=%d rss_mb=%.1f delta_mb=%.1f peak_mb=%.1f",
                              i, held.reduce(0) { $0 + $1.state.items.count }, snapshotBytes,
                              rssMB(), rssMB() - base, peakRssMB()))
            }
        }
        held.removeAll()
        report(String(format: "memory stage=released rss_mb=%.1f delta_mb=%.1f peak_mb=%.1f", rssMB(), rssMB() - base, peakRssMB()))
    }
}
