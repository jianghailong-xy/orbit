import AppKit
import SwiftUI
import XCTest
import OrbitKit
@testable import OrbitApp

/// Frames of the real transfer card on the Mac, built the way the conversation builds it: events through
/// `TranscriptReducer`, rows through `TranscriptRows.build`, each transfer row drawn by `DriveTransferCardView`.
/// PNGs land in `src/macos/build/evidence/documents-transfer-macos/`.
@MainActor
final class DriveTransferShotsTests: XCTestCase {
    private static let names = ["十二月月令图/十二月月令轴.09.九月.台北故宫博物院藏.jpg", "鸟谱选页/鸟谱选页_img1_12.jpg",
                                "老地图/廣東至暹羅水陸道里圖.jpg", "缂丝刺绣/谢安赌墅图.宋.缂丝.jpg", "单幅/万寿宫香.jpg",
                                "单幅/魁星图.jpg", "单幅/乾隆款掐丝珐琅太平有象.jpg", "单幅/Canton Pagoda 2300 years old.jpg",
                                "单幅/a.jpg", "单幅/b.jpg"]
    private static let sizes = [18_600_000, 4_100_000, 12_900_000, 7_700_000, 2_600_000, 11_400_000, 6_000_000,
                                3_400_000, 1_000_000, 2_000_000]

    private var evidenceDir: URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<10 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("src/macos/OrbitApp/Package.swift").path) {
                let out = dir.appendingPathComponent("src/macos/build/evidence/documents-transfer-macos")
                try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
                return out
            }
            dir = dir.deletingLastPathComponent()
        }
        let out = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("documents-transfer-macos")
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        return out
    }

    private static func ts(_ s: Int) -> String { "2026-11-24T10:00:\(String(format: "%02d", s))Z" }

    /// The conversation's rows for an upload of every file, `done` of them answered (the one at `fail` refused), and
    /// the live byte count of the one going.
    private static func rows(done: Int, fail: Int? = nil, live: (Int, String)? = nil,
                             paths: [String] = names) -> [TranscriptRow] {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 1, type: .assistant, payload: .object([
            "text": .string("I'll copy them into Documents under `/书格/2026-11-24/`.")])))
        for (i, name) in paths.enumerated() {
            r.apply(RunEvent(seq: 10 + i, type: .toolUse, ts: ts(i), payload: .object([
                "toolUseId": .string("call_\(i)"), "name": .string("mcp__orbit__documents_put"),
                "input": .object(["path": .string("/书格/2026-11-24/\(name)")]),
            ])))
        }
        for i in 0..<done {
            let content = i == fail
                ? #"{"receiptVersion":1,"ok":false,"error":{"message":"Documents quota reached: 10 GB of 10 GB used."}}"#
                : #"{"receiptVersion":1,"ok":true,"outcome":"written","entity":{"link":"orbit-document:e\#(i)","sizeBytes":\#(sizes[i])}}"#
            r.apply(RunEvent(seq: 40 + i, type: .toolResult, ts: ts(2 * i + 2), payload: .object([
                "toolUseId": .string("call_\(i)"), "content": .string(content),
            ])))
        }
        if let live {
            let (i, line) = live
            r.apply(RunEvent(seq: 0, type: .toolOutput, payload: .object([
                "toolUseId": .string("call_\(i)"), "content": .string(line), "snapshotSeq": .int(99),
            ])))
        }
        return TranscriptRows.build(state: r.state, statusCards: [], canPageOlder: false, showWorkingIndicator: false)
    }

    private struct Frame: View {
        let title: String
        let rows: [TranscriptRow]
        let live: Bool

        var body: some View {
            VStack(alignment: .leading, spacing: 8) {
                Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                ForEach(rows) { row in
                    switch row {
                    case .transfer(let kind, let cards):
                        DriveTransferCardView(kind: kind, cards: cards, live: live, showInDrive: { _ in })
                    case .item(.assistant(let bubble)):
                        Text(bubble.text).font(.orbitProse)
                    default:
                        EmptyView()
                    }
                }
            }
            .frame(width: 680, alignment: .leading)
        }
    }

    private func write<V: View>(_ name: String, _ view: V, size: CGSize, dark: Bool = false) throws {
        let root = view
            .padding(24)
            .frame(width: size.width, height: size.height, alignment: .top)
            .background(Color(nsColor: .windowBackgroundColor))
            .environment(\.colorScheme, dark ? .dark : .light)
        let hosting = NSHostingView(rootView: root)
        hosting.frame = CGRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.contentView = hosting
        window.orderFrontRegardless()
        RunLoop.main.run(until: Date().addingTimeInterval(1.2))
        hosting.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
        try png.write(to: evidenceDir.appendingPathComponent("\(name).png"))
        window.orderOut(nil)
        XCTAssertGreaterThan(png.count, 1_000, "\(name) looks empty")
    }

    private var gallery: some View {
        VStack(alignment: .leading, spacing: 28) {
            Frame(title: "Uploading, 6 of 10 in", rows: Self.rows(done: 5, live: (5, "Uploaded 3200000 of 11400000 bytes")),
                  live: true)
            Frame(title: "Finished", rows: Self.rows(done: 10), live: false)
            Frame(title: "One failed", rows: Self.rows(done: 10, fail: 3), live: false)
            Frame(title: "One file, going",
                  rows: Self.rows(done: 0, live: (0, "Uploaded 3200000 of 11400000 bytes"), paths: ["单幅/魁星图.jpg"]),
                  live: true)
            Frame(title: "One file, done", rows: Self.rows(done: 1, paths: ["单幅/魁星图.jpg"]), live: false)
        }
    }

    func testGallery() throws {
        // Every frame must have drawn its transfer row through the real row builder.
        XCTAssertTrue(Self.rows(done: 10).contains { if case .transfer = $0 { return true } else { return false } })
        try write("mac-documents-transfer", gallery, size: CGSize(width: 740, height: 1500))
    }

    func testGalleryDark() throws {
        try write("mac-documents-transfer-dark", gallery, size: CGSize(width: 740, height: 1500), dark: true)
    }
}
