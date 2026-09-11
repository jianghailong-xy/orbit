import Foundation
import XCTest
@testable import OrbitKit

/// The same cases the web module is held to (`src/web/src/lib/deliveredMessage.test.ts`), because
/// the two render the same echoed text and a rule that holds on one client and not the other is
/// worse than no rule.
final class DeliveredMessageTests: XCTestCase {

    // The exact shapes the server appends (ReferenceExpansionService, ListEventsService,
    // background-jobs-context).
    private let conditions = """
        <list-conditions list="6ba7b810-9dad-11d1-80b4-00c04fd430c8" title="FineWeb">
          配额挡住派发｜12 个就绪任务被配额挡住｜累计 47 次
          以上是控制面在你上次收到消息之后观察到的，不是用户说的。
        </list-conditions>
        """
    private let backgroundJobs = """
        <background-jobs>
          你不在的时候结束了：
            bgj_3a1af2b50428｜job｜npm run build｜completed｜退出码 0｜输出 /root/.orbit/runs/x/bgj_3a1af2b50428.output
          这是控制面替你记下的，不是用户说的。输出文件由 runner 持有，engine 换过也还在。
        </background-jobs>
        """
    private let refList = """
        <referenced-list id="6ba7b810-9dad-11d1-80b4-00c04fd430c8">
          标题   FineWeb CC-MAIN-2025-26
        </referenced-list>
        """
    private let refTask = """
        <referenced-task id="550e8400-e29b-41d4-a716-446655440000">
          标题   [W 009/250] → WARC
        </referenced-task>
        """
    private let coordinator = """
        <orbit_project_coordinator_context>
          你是项目（id: 4gfFCpGvM8ZoqYTZwH3cCB）的协调会话。
          这里用来协调任务，不是替任务干活。
        </orbit_project_coordinator_context>
        """

    // MARK: the older reading, for an event stored without a note

    func testTakesAnAppendedBlockOutOfTheBubbleAndKeepsItVerbatim() {
        let out = splitDeliveredMessage("把这个项目协调起来\n\n\(coordinator)")

        XCTAssertEqual(out.text, "把这个项目协调起来")
        // Verbatim: the entry is the only remaining way to see what the model actually read.
        XCTAssertEqual(out.injected, [coordinator])
    }

    func testPeelsSeveralBlocksInAppendOrder() {
        let out = splitDeliveredMessage("看下 #FineWeb\n\n\(refList)\n\n\(refTask)\n\n\(coordinator)")

        XCTAssertEqual(out.text, "看下 #FineWeb")
        XCTAssertEqual(out.injected, [refList, refTask, coordinator])
        XCTAssertEqual(describeInjected(out.injected),
                       "referenced list, referenced task, project coordinator context")
    }

    func testTwoIdenticalAdjacentBlocksComeOutAsTwo() {
        // A message naming two tasks produces exactly this. The web version got it wrong first:
        // one pattern with a backreference and an end anchor swallows both into one.
        let out = splitDeliveredMessage("q\n\n\(refTask)\n\n\(refTask)")

        XCTAssertEqual(out.injected.count, 2)
        XCTAssertEqual(describeInjected(out.injected), "referenced task ×2")
    }

    func testLeavesAnOrdinaryMessageAlone() {
        // Overwhelmingly the common case.
        let plain = "把 WARC 转换拆开并行跑，它不依赖去重完成。"

        XCTAssertEqual(splitDeliveredMessage(plain), DeliveredMessage(text: plain, injected: []))
    }

    func testDoesNotEatATagTheUserTypedMidSentence() {
        // Why the match is anchored to the end: someone asking about this very feature must not
        // have their question silently rewritten.
        let asking = "为什么 <referenced-task> 这个块会出现在我自己的气泡里？\n\n它是谁加的？"

        XCTAssertEqual(splitDeliveredMessage(asking).text, asking)
    }

    func testDoesNotStripAnUnclosedBlock() {
        let broken = "问题\n\n<referenced-list id=\"x\">\n  一半就断了"

        XCTAssertTrue(splitDeliveredMessage(broken).injected.isEmpty)
    }

    func testDoesNotStripSomebodyElsesTag() {
        let code = "帮我看下这段\n\n<my-component id=\"x\">\n  <div/>\n</my-component>"

        XCTAssertTrue(splitDeliveredMessage(code).injected.isEmpty)
    }

    func testHandlesAMessageThatIsNothingButInjectedContext() {
        // A server-seeded turn with no text of its own.
        let out = splitDeliveredMessage("\n\n\(coordinator)")

        XCTAssertEqual(out.text, "")
        XCTAssertEqual(out.injected.count, 1)
    }

    func testNeverReadsAConditionBoardOrABackgroundJobsBlockOutOfTheText() {
        // Those two are told apart by the note ingest records. Someone who pastes one into the
        // composer — to ask why it showed up, say — sent exactly that, and must see exactly that.
        for block in [conditions, backgroundJobs] {
            let pasted = "这是什么？\n\n\(block)"

            XCTAssertEqual(splitDeliveredMessage(pasted), DeliveredMessage(text: pasted, injected: []))
        }
    }

    // MARK: where the apiserver recorded that the person's words end

    func testSplitsExactlyWhereTheRecordedNoteBegins() {
        let note = "\n\n\(backgroundJobs)"

        let out = splitRecordedNote("继续\(note)", note: note)

        XCTAssertEqual(out?.text, "继续")
        XCTAssertEqual(out?.note, backgroundJobs)
    }

    func testLeavesWhatThePersonTypedWholeEvenABlockOfTheSameKind() {
        // Someone pasted a board, and delivery then appended the current one: only the second is
        // Orbit's.
        let typed = "这是什么？\n\n\(conditions)"
        let note = "\n\n\(conditions)"

        XCTAssertEqual(splitRecordedNote("\(typed)\(note)", note: note)?.text, typed)
    }

    func testHasNothingToSplitWithoutANoteOrWithOneThatIsNotTheEndOfTheText() {
        XCTAssertNil(splitRecordedNote("q\n\n\(conditions)", note: nil))
        XCTAssertNil(splitRecordedNote("q", note: "\n\n\(conditions)"))
        XCTAssertNil(splitRecordedNote("q\n\n", note: "\n\n"), "a blank note records nothing")
    }

    func testCutsWhereTheNoteBeginsWhenACharacterStraddlesTheCut() {
        // `\r\n` is one Character, so compared by Characters the note is not a suffix at all: the
        // block would stay in the bubble and the echo would never match the optimistic one.
        let note = "\n\n\(backgroundJobs)"

        XCTAssertEqual(splitRecordedNote("第一行\r\(note)", note: note)?.text, "第一行\r")
        XCTAssertEqual(splitRecordedNote("line one\r\(note)", note: note)?.text, "line one\r")
    }

    // MARK: naming what was attached

    func testNamesWhatWasAttachedSoTheReplyIsNotUnexplained() {
        let out = splitDeliveredMessage("q\n\n\(refList)\n\n\(coordinator)")

        XCTAssertEqual(describeInjected(out.injected), "referenced list, project coordinator context")
    }

    func testNamesARecordedNoteByTheBlockItOpensWithTheTwoOnlyANoteCanCarryIncluded() {
        XCTAssertEqual(describeNote("\n\n\(backgroundJobs)"), "background jobs")
        XCTAssertEqual(describeNote(conditions), "list conditions")
        XCTAssertEqual(describeNote(coordinator), "project coordinator context")
    }

    func testNamesEveryBlockOneDeliveryAppendedTheWayTheOlderReadingNamesWhatItFound() {
        // Delivery appends references, then the condition board, then background jobs, then the
        // coordinator's role: a coordinator with a build still running gets two blocks in one note.
        let appended = "\n\n\(refTask)\n\n\(refTask)\n\n\(backgroundJobs)\n\n\(coordinator)"

        XCTAssertEqual(describeNote(appended), "referenced task ×2, background jobs, project coordinator context")

        let older = "\n\n\(refList)\n\n\(coordinator)"
        XCTAssertEqual(describeNote(older), describeInjected(splitDeliveredMessage("q\(older)").injected))
    }

    func testStillNamesAnOpeningItDoesNotRecogniseGenerically() {
        XCTAssertEqual(describeNote("<orbit_something_new>\n  x\n</orbit_something_new>"), "context")
        XCTAssertEqual(describeNote("<background-jobs-v2>\n  x\n</background-jobs-v2>"), "context")
        XCTAssertEqual(describeNote("[Image #1]"), "context")
    }

    // MARK: the other client, and the view that draws the entry
    //
    // Neither compiles with OrbitKit: the web module is another language, and the SwiftUI bubble is
    // built only by the macOS and iOS jobs. So both are read as source, and each assertion is
    // written so that drifting from web, or detaching the view from `attached`, is what turns it red.

    private enum SourceError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found. If it moved, move this check with it rather than "
                    + "deleting it: nothing else on Linux sees whether the entry still reads the same "
                    + "on both clients and is still drawn inside the bubble."
            }
        }
    }

    /// A file of this repository, found by walking up from this test rather than by counting `..`.
    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw SourceError.missing(relative)
    }

    /// From one marker to the next occurrence of another, so a match elsewhere in the file cannot
    /// answer for the stretch being asserted about.
    private func section(_ source: String, from: String, to: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw SourceError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    func testEveryBlockIsCalledWhatWebCallsIt() throws {
        let table = try section(try source("src/web/src/lib/deliveredMessage.ts"),
                                from: "const TAG_LABEL", to: "};")
        var web: [String: String] = [:]
        for line in table.split(separator: "\n").dropFirst() {
            let pair = line.split(separator: ":", maxSplits: 1)
                .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: " ',")) }
            if pair.count == 2 { web[pair[0]] = pair[1] }
        }

        XCTAssertEqual(web, injectedTagLabels, "a block goes by the same name on both clients")

        let entry = try section(try source("src/web/src/components/Transcript.tsx"),
                                from: "function ControlPlaneNote", to: "\n}\n")
        XCTAssertTrue(entry.contains("`⊕ Orbit attached: ${kind}`"),
                      "and web's entry is signed the way the native one is")
    }

    func testTheBubbleDrawsOneEntryInsideItselfWhicheverWayItWasToldApart() throws {
        let view = try section(
            try source("src/macos/OrbitApp/Sources/OrbitApp/Views/Console/MessageBubbles.swift"),
            from: "struct UserBubbleView: View", to: "struct AssistantBubbleView: View")
        let bubble = try section(view, from: "if let attached = bubble.attached {",
                                 to: ".background(.tint.opacity(0.15)")
        let entry = try section(view, from: "private func attachedEntry", to: "\n    }\n")

        XCTAssertTrue(bubble.contains("GridRow { attachedEntry(attached) }"),
                      "the entry is drawn inside the tinted bubble, not under it")
        XCTAssertTrue(bubble.contains(".gridCellUnsizedAxes(.horizontal)"),
                      "parted from the words by a rule that does not widen a bubble hugging its text")
        XCTAssertTrue(entry.contains(#"Text("⊕ Orbit attached: \(attached.kind)")"#),
                      "signed as web signs it, with the kind its note or the older reading was named")
        XCTAssertTrue(entry.contains("Text(attached.text)"), "and opening to the text the model read")
        XCTAssertFalse(view.contains("bubble.injected"),
                       "a note and the older reading are one entry: nothing is drawn from `injected` alone")
    }
}
