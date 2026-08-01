import XCTest
@testable import OrbitKit

/// The ⌘K palette's snippet highlighting, kept in lockstep with the web `splitHighlight` tests.
final class SessionSearchHighlightTests: XCTestCase {
    private func rejoin(_ segs: [SessionSearchHighlight.Segment]) -> String {
        segs.map(\.text).joined()
    }

    func testMarksSingleMatchAndKeepsSurroundingText() {
        let segs = SessionSearchHighlight.split("fix the merge bug", query: "merge")
        XCTAssertEqual(segs, [
            .init(text: "fix the ", match: false),
            .init(text: "merge", match: true),
            .init(text: " bug", match: false),
        ])
    }

    func testMarksEveryOccurrence() {
        let segs = SessionSearchHighlight.split("merge after merge", query: "merge")
        XCTAssertEqual(segs.filter(\.match).count, 2)
        XCTAssertEqual(rejoin(segs), "merge after merge")
    }

    func testAdjacentMatches() {
        let segs = SessionSearchHighlight.split("abab", query: "ab")
        XCTAssertEqual(segs, [.init(text: "ab", match: true), .init(text: "ab", match: true)])
        XCTAssertEqual(rejoin(segs), "abab")
    }

    func testCaseInsensitiveButPreservesOriginalCasing() {
        let segs = SessionSearchHighlight.split("Merge to Main", query: "merge")
        XCTAssertEqual(segs.first, .init(text: "Merge", match: true))
        XCTAssertEqual(rejoin(segs), "Merge to Main")
    }

    func testChinese() {
        let segs = SessionSearchHighlight.split("修复会话列表的排序", query: "会话列表")
        XCTAssertEqual(segs, [
            .init(text: "修复", match: false),
            .init(text: "会话列表", match: true),
            .init(text: "的排序", match: false),
        ])
    }

    /// The server collapsed "SSE   keepalive" to "SSE keepalive"; a query still carrying the
    /// double space must still find it.
    func testCollapsesWhitespaceInQuery() {
        let segs = SessionSearchHighlight.split("the SSE keepalive fix", query: "SSE   keepalive")
        XCTAssertEqual(segs.filter(\.match), [.init(text: "SSE keepalive", match: true)])
    }

    func testMissingOrEmptyQueryFallsBackToPlainText() {
        XCTAssertEqual(SessionSearchHighlight.split("nothing here", query: "zzz"),
                       [.init(text: "nothing here", match: false)])
        XCTAssertEqual(SessionSearchHighlight.split("nothing here", query: "   "),
                       [.init(text: "nothing here", match: false)])
    }

    func testEmptyText() {
        XCTAssertEqual(SessionSearchHighlight.split("", query: "merge"), [])
    }

    func testNeverInventsOrLosesCharacters() {
        for (text, q) in [("aaa", "a"), ("merge merge merge", "merge"), ("会话会话", "会话"), ("edge", "edge")] {
            XCTAssertEqual(rejoin(SessionSearchHighlight.split(text, query: q)), text)
        }
    }
}

/// The search payload decodes, including the lenient `matchField` fallback that keeps an older
/// client working against a server that added a field.
final class SessionSearchCodableTests: XCTestCase {
    func testDecodesResponse() throws {
        let json = """
        {"q":"4QISUlGbd1LAaxJywzvT7x","contentSearched":true,"hits":[
          {"id":"a","title":"Fix merge","status":"PENDING","runStatus":"CANCELLED","sessionState":"COMPLETED","runState":"CANCELLED","filingState":"ARCHIVED","agent":{"id":"ag","name":"orbit"},
           "runnerId":"r","taskId":null,"taskTitle":null,"lastTurnAt":"2026-07-26T10:00:00.000Z",
           "createdAt":"2026-07-26T09:00:00.000Z","archivedAt":null,"deletedAt":null,
           "endReason":null,"matchField":"id","snippet":"4QISUlGbd1LAaxJywzvT7x"}
        ]}
        """.data(using: .utf8)!
        let res = try JSONDecoder().decode(SessionSearchResponse.self, from: json)
        XCTAssertTrue(res.contentSearched)
        XCTAssertEqual(res.hits.count, 1)
        XCTAssertEqual(res.hits[0].matchField, .id)
        XCTAssertEqual(res.hits[0].runStatus, .cancelled)
        XCTAssertEqual(res.hits[0].effectiveRunStatus, .cancelled)
        XCTAssertEqual(res.hits[0].sessionState, .completed)
        XCTAssertEqual(res.hits[0].runState, .cancelled)
        XCTAssertEqual(res.hits[0].effectiveRunState, .cancelled)
        XCTAssertEqual(res.hits[0].filingState, .archived)
        XCTAssertEqual(res.hits[0].effectiveFilingState, .archived)
        XCTAssertEqual(res.hits[0].agent?.name, "orbit")
    }

    func testUnknownMatchFieldFallsBackInsteadOfFailing() throws {
        let json = """
        {"q":"x","contentSearched":false,"hits":[
          {"id":"a","title":"t","status":"PENDING","agent":null,"runnerId":null,"taskId":null,
           "taskTitle":null,"lastTurnAt":null,"createdAt":null,"archivedAt":null,"deletedAt":null,
           "endReason":null,"matchField":"something_new","snippet":null}
        ]}
        """.data(using: .utf8)!
        let res = try JSONDecoder().decode(SessionSearchResponse.self, from: json)
        XCTAssertEqual(res.hits[0].matchField, .message)
        XCTAssertNil(res.hits[0].runStatus)
        XCTAssertEqual(res.hits[0].effectiveRunStatus, .pending)
        XCTAssertEqual(res.hits[0].effectiveRunState, .queued)
        XCTAssertNil(res.hits[0].sessionState)
        XCTAssertNil(res.hits[0].runState)
        XCTAssertNil(res.hits[0].filingState)
        XCTAssertEqual(res.hits[0].effectiveFilingState, .open)
    }

    func testOldSearchPayloadDerivesFilingStateFromTimestamps() throws {
        let json = """
        {"q":"x","contentSearched":true,"hits":[
          {"id":"a","title":"t","status":"SUCCEEDED","archivedAt":"2026-08-01T00:00:00Z",
           "deletedAt":null,"matchField":"title"},
          {"id":"b","title":"u","status":"FAILED","archivedAt":"2026-08-01T00:00:00Z",
           "deletedAt":"2026-08-02T00:00:00Z","matchField":"title"}
        ]}
        """.data(using: .utf8)!
        let hits = try JSONDecoder().decode(SessionSearchResponse.self, from: json).hits
        XCTAssertEqual(hits[0].effectiveFilingState, .archived)
        XCTAssertEqual(hits[1].effectiveFilingState, .trash)
    }
}
