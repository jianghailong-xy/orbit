import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
import OrbitKit
@testable import OrbitApp

/// The transcript pages a console reads, answered from a script: `after=<seq>` and `tail=` each by
/// what the test set, and every page read recorded in order.
private final class ReopenPagesURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var afterPages: [Int: String] = [:]
    private static var tailPage: String?
    private static var failAfter = false
    private static var log: [String] = []

    static func script(after: [Int: String] = [:], tail: String? = nil, failAfter: Bool = false) {
        lock.lock()
        defer { lock.unlock() }
        afterPages = after
        tailPage = tail
        self.failAfter = failAfter
        log = []
    }

    /// The page reads made, as `after=<seq>&limit=<n>` or `tail=<n>`.
    static var reads: [String] {
        lock.lock()
        defer { lock.unlock() }
        return log
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { query.first { $0.name == name }?.value }
        var body: String?
        var fail = false
        if url.path.hasSuffix("/events/page") {
            Self.lock.lock()
            if let after = value("after").flatMap(Int.init) {
                Self.log.append("after=\(after)&limit=\(value("limit") ?? "")")
                fail = Self.failAfter
                body = Self.afterPages[after]
            } else if let tail = value("tail") {
                Self.log.append("tail=\(tail)")
                body = Self.tailPage
            }
            Self.lock.unlock()
        }
        if fail {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let response = HTTPURLResponse(url: url, statusCode: body == nil ? 404 : 200,
                                       httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data((body ?? "").utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// A session reopened from the transcript this app kept of it (`ConsoleRegistry` restores it from
/// disk, or the console is still in memory) is brought up to its newest event before the stream
/// opens: one page read after the kept max seq, landing in one publish when it reaches the tail, and
/// a fresh tail page in place of the kept window when the gap is wider than that page — not a walk
/// through the gap a page and a publish at a time, which the reader watched as the conversation
/// fast-forwarding (owner report 2026-11-23; web 4e53172f02, `catchUp`).
@MainActor
final class ReopenCatchUpTests: XCTestCase {
    override func tearDown() {
        ReopenPagesURLProtocol.script()
        super.tearDown()
    }

    /// One user/assistant exchange per two seqs, as the server pages them.
    private static func events(_ seqs: ClosedRange<Int>) -> String {
        seqs.map { seq in
            let turn = "t\((seq + 1) / 2)"
            return seq % 2 == 1
                ? #"{"seq":\#(seq),"type":"user","turnId":"\#(turn)","payload":{"text":"Question \#(seq)"}}"#
                : #"{"seq":\#(seq),"type":"assistant","turnId":"\#(turn)","payload":{"text":"Reply \#(seq)"}}"#
        }.joined(separator: ",")
    }

    private static func page(_ seqs: ClosedRange<Int>, hasMore: Bool = true, after: Int? = nil) -> String {
        let cursor = after.map { #","after":\#($0)"# } ?? ""
        return #"{"events":[\#(events(seqs))],"hasMore":\#(hasMore)\#(cursor)}"#
    }

    /// The transcript kept from the last visit: seqs 2001…2200, the newest page of a long session.
    private func keptWindow() throws -> TranscriptReducer {
        var reducer = TranscriptReducer()
        let page = try JSONDecoder().decode(EventPage.self,
                                            from: Data(Self.page(2001...2200, before: 2001).utf8))
        reducer.applyTailPage(page)
        XCTAssertEqual(reducer.state.maxSeq, 2200)
        return reducer
    }

    private static func page(_ seqs: ClosedRange<Int>, before: Int) -> String {
        #"{"events":[\#(events(seqs))],"hasMore":true,"before":\#(before)}"#
    }

    private func reopenedConsole() throws -> ConsoleModel {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ReopenPagesURLProtocol.self]
        let baseURL = URL(string: "https://orbit.test")!
        let tokens = InMemoryTokenStore()
        return ConsoleModel(sessionID: "S1", baseURL: baseURL, tokenStore: tokens,
                            attachments: AttachmentImageStore(baseURL: baseURL, tokenStore: tokens),
                            restoring: try keptWindow(),
                            session: URLSession(configuration: configuration))
    }

    private func texts(_ console: ConsoleModel) -> [String] {
        console.state.items.compactMap {
            switch $0 {
            case .user(let bubble): return bubble.text
            case .assistant(let bubble): return bubble.text
            default: return nil
            }
        }
    }

    func testAGapThatFitsOnePageIsCaughtUpWithOneReadAndOnePublish() async throws {
        ReopenPagesURLProtocol.script(after: [2200: Self.page(2201...2350)])
        let console = try reopenedConsole()
        let revision = console.stateRevision

        await console.catchUpOnReopen()

        XCTAssertEqual(ReopenPagesURLProtocol.reads, ["after=2200&limit=200"], "one page read, nothing else")
        XCTAssertEqual(console.stateRevision, revision + 1, "the gap lands in one publish")
        XCTAssertEqual(console.state.maxSeq, 2350, "so the stream opens past it")
        XCTAssertEqual(texts(console).first, "Question 2001", "below the kept window")
        XCTAssertEqual(texts(console).last, "Reply 2350")
    }

    func testAGapWiderThanOnePageIsNotPagedThroughButReplacedByATailPage() async throws {
        // 1000 newer events: five pages of 200, each naming the next.
        var pages: [Int: String] = [:]
        for start in stride(from: 2201, to: 3201, by: 200) {
            let end = start + 199
            pages[start - 1] = Self.page(start...end, after: end < 3200 ? end : nil)
        }
        ReopenPagesURLProtocol.script(after: pages, tail: Self.page(3001...3200, before: 3001))
        let console = try reopenedConsole()
        let revision = console.stateRevision

        await console.catchUpOnReopen()

        XCTAssertEqual(ReopenPagesURLProtocol.reads, ["after=2200&limit=200", "tail=200"],
                       "one read finds the gap is wider than a page, then one tail page, as a cold open seeds")
        XCTAssertEqual(console.stateRevision, revision + 1,
                       "the kept window is switched to the tail page once, never shown a page at a time")
        XCTAssertEqual(console.state.maxSeq, 3200)
        XCTAssertEqual(console.state.oldestSeq, 3001, "the window is the tail page alone")
        XCTAssertEqual(texts(console).first, "Question 3001", "no kept row is left above it")
        XCTAssertEqual(texts(console).last, "Reply 3200")
        XCTAssertTrue(console.state.hasMoreOlder, "the middle of the gap is paged back to by scrolling up")
        XCTAssertFalse(console.detached, "a reader at the tail is at the tail, and the stream opens")
    }

    func testAFailedReadLeavesTheKeptWindowForTheStreamToResumeFrom() async throws {
        ReopenPagesURLProtocol.script(tail: Self.page(3001...3200, before: 3001), failAfter: true)
        let console = try reopenedConsole()
        let revision = console.stateRevision
        let kept = console.state

        await console.catchUpOnReopen()

        XCTAssertEqual(ReopenPagesURLProtocol.reads, ["after=2200&limit=200"],
                       "no tail page either: a read that failed says nothing about the gap")
        XCTAssertEqual(console.stateRevision, revision, "nothing is published")
        XCTAssertEqual(console.state, kept, "the kept window stays as it was")
        XCTAssertEqual(console.state.maxSeq, 2200, "so the stream resumes from the kept seq and replays the gap")
        XCTAssertFalse(console.detached)
    }

    /// A reader up in the history — scrolled up, or held at the card the transcript was opened at
    /// (`TranscriptLanding`, which takes the transcript off the bottom) — is kept as the paged
    /// catch-up kept them: the gap lands page by page below what they are reading, and past its
    /// budget the window is kept with its bottom a gap rather than swapped under them.
    func testAReaderUpInTheHistoryKeepsThePagedCatchUp() async throws {
        var pages: [Int: String] = [:]
        for start in stride(from: 2201, to: 3401, by: 200) {
            let end = start + 199
            pages[start - 1] = Self.page(start...end, after: end)
        }
        ReopenPagesURLProtocol.script(after: pages, tail: Self.page(3201...3400, before: 3201))
        let console = try reopenedConsole()
        console.setReadingHistory(true)

        await console.catchUpOnReopen()

        XCTAssertEqual(ReopenPagesURLProtocol.reads,
                       ["after=2200&limit=200", "after=2400&limit=200", "after=2600&limit=200",
                        "after=2800&limit=200", "after=3000&limit=200"],
                       "the same five pages as before, and no tail page under the reader")
        XCTAssertEqual(texts(console).first, "Question 2001", "what they were reading stays")
        XCTAssertEqual(console.state.maxSeq, 3200)
        XCTAssertEqual(console.newerCursor, 3200, "kept, its bottom is a gap the reader pages down across")
    }
}
