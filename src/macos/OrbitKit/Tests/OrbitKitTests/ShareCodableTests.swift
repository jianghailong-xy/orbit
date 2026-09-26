import XCTest
@testable import OrbitKit

/// Pins the wire contract the Share panel depends on (docs/share-links-design.md §5): what
/// `GET | PUT /{sessions|tasks|projects}/:id/share` answer — the link with its layers, expiry and
/// visits, and each kind's layer counts — what a `PUT` sends, and the `shareToken` the owner's
/// `GET /sessions/:id` still carries.
final class ShareCodableTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    /// The body exactly as it goes on the wire, keys sorted.
    private func sent(_ request: PutShareLinkRequest) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return String(decoding: try encoder.encode(request), as: UTF8.self)
    }

    // MARK: GET — the link and its counts

    func testATaskLinkDecodesWithItsLayersExpiryAndVisits() throws {
        let read = try decode(ShareLinkRead.self, """
            {"link":{"id":"5hQm2kX0bPzY8wL3nV1cRa","kind":"TASK","token":"Hs2Lq8Vn0bXw3tPz6KcR1mY7uDe4JfAa",
              "include":{"commentsAndFiles":true,"conversations":false,"toolOutput":true},
              "expiresAt":"2026-10-02T09:00:00.000Z","revokedAt":null,"viewCount":14,
              "lastViewedAt":"2026-09-25T13:00:00.000Z","createdAt":"2026-09-25T04:00:00.000Z",
              "updatedAt":"2026-09-25T04:10:00.000Z","state":"ACTIVE","stateReason":null,
              "root":{"id":"34UozoiaJIsxCZj728bfe","title":"T8 原生统一分享面板","status":"OPEN"}},
             "counts":{"comments":29,"files":2,"transcripts":14}}
            """)
        let link = try XCTUnwrap(read.link)
        XCTAssertEqual(link.kind, .task)
        XCTAssertEqual(link.token, "Hs2Lq8Vn0bXw3tPz6KcR1mY7uDe4JfAa")
        XCTAssertEqual(link.include, ShareInclude(commentsAndFiles: true, conversations: false, toolOutput: true))
        XCTAssertNil(link.include.taskPages, "a task link has no Task pages layer")
        XCTAssertEqual(link.expiresAt, "2026-10-02T09:00:00.000Z")
        XCTAssertEqual(link.viewCount, 14)
        XCTAssertEqual(link.lastViewedAt, "2026-09-25T13:00:00.000Z")
        XCTAssertEqual(link.state, .active)
        XCTAssertNil(link.stateReason)
        XCTAssertEqual(link.root, ShareRootSummary(id: "34UozoiaJIsxCZj728bfe", title: "T8 原生统一分享面板", status: "OPEN"))
        XCTAssertEqual(read.counts, ShareCounts(comments: 29, files: 2, transcripts: 14))
    }

    func testASessionLinkDecodesItsRootsPlaceAndItsTwoCounts() throws {
        let read = try decode(ShareLinkRead.self, """
            {"link":{"id":"L2","kind":"SESSION","token":"tok","include":{"toolOutput":false},
              "expiresAt":null,"revokedAt":null,"viewCount":0,"lastViewedAt":null,
              "createdAt":"2026-09-25T04:00:00.000Z","updatedAt":"2026-09-25T04:00:00.000Z",
              "state":"PAUSED","stateReason":"IN_TRASH",
              "root":{"id":"s1","title":null,"status":"COMPLETED","lifecycleState":"TRASHED","completedAt":"2026-08-01T00:00:00.000Z"}},
             "counts":{"messages":77,"toolCalls":120}}
            """)
        let link = try XCTUnwrap(read.link)
        XCTAssertEqual(link.kind, .session)
        XCTAssertEqual(link.include.toolOutput, false)
        XCTAssertNil(link.expiresAt, "null expiresAt is Never")
        XCTAssertEqual(link.state, .paused)
        XCTAssertEqual(link.stateReason, "IN_TRASH")
        XCTAssertNil(link.root.title)
        XCTAssertEqual(link.root.lifecycleState, "TRASHED")
        XCTAssertEqual(link.root.completedAt, "2026-08-01T00:00:00.000Z")
        XCTAssertEqual(read.counts, ShareCounts(messages: 77, toolCalls: 120))
    }

    func testAProjectWithNoLinkStillSaysHowMuchEachLayerHolds() throws {
        let read = try decode(ShareLinkRead.self, """
            {"link":null,"counts":{"tasks":12,"comments":29,"files":0,"runs":13,"transcripts":14}}
            """)
        XCTAssertNil(read.link)
        XCTAssertEqual(read.counts, ShareCounts(tasks: 12, comments: 29, files: 0, runs: 13, transcripts: 14))
    }

    func testAStateThisBuildDoesNotKnowDoesNotFailTheRead() throws {
        let link = try decode(ShareLink.self, """
            {"id":"L3","kind":"PROJECT","token":"t","include":{"taskPages":true,"commentsAndFiles":false,
             "conversations":false,"toolOutput":true},"expiresAt":null,"revokedAt":null,"viewCount":1,
             "lastViewedAt":null,"createdAt":"c","updatedAt":"u","state":"ARCHIVED","stateReason":null,
             "root":{"id":"p1","title":"P","status":"OPEN"}}
            """)
        XCTAssertEqual(link.state, .unknown)
        XCTAssertEqual(link.include.taskPages, true)
    }

    // MARK: PUT — what a press sends

    func testASwitchSendsOnlyItsOwnLayerAndLeavesTheExpiryAlone() throws {
        var include = ShareInclude()
        include[.conversations] = true
        // expiresAt is left out, so the server leaves it as it is.
        XCTAssertEqual(try sent(PutShareLinkRequest(include: include)), #"{"include":{"conversations":true}}"#)
    }

    func testOpeningSendsAnEmptyBody() throws {
        XCTAssertEqual(try sent(PutShareLinkRequest()), "{}", "the server opens the link with the defaults")
    }

    func testNeverSendsAnExplicitNullAndADurationSendsTheInstant() throws {
        XCTAssertEqual(try sent(PutShareLinkRequest(expiresAt: .clear)), #"{"expiresAt":null}"#,
                       "null is Never; a missing key would change nothing")
        XCTAssertEqual(try sent(PutShareLinkRequest(expiresAt: .set("2026-10-02T09:00:00.000Z"))),
                       #"{"expiresAt":"2026-10-02T09:00:00.000Z"}"#)
    }

    func testAPutAnswerIsTheLinkAsItNowStands() throws {
        let link = try decode(ShareLink.self, """
            {"id":"L4","kind":"PROJECT","token":"NewToken","include":{"taskPages":false,"commentsAndFiles":false,
             "conversations":false,"toolOutput":true},"expiresAt":null,"revokedAt":null,"viewCount":0,
             "lastViewedAt":null,"createdAt":"2026-09-25T04:00:00.000Z","updatedAt":"2026-09-25T04:00:00.000Z",
             "state":"ACTIVE","stateReason":null,"root":{"id":"p1","title":"P","status":"OPEN"}}
            """)
        XCTAssertEqual(link.kind, .project)
        XCTAssertEqual(link.include[.taskPages], false)
        XCTAssertEqual(link.include[.toolOutput], true)
    }

    func testEachKindAnswersUnderItsOwnPath() {
        XCTAssertEqual(ShareRootKind.allCases.map(\.pathSegment), ["sessions", "tasks", "projects"])
        XCTAssertEqual(ShareRootKind.allCases.map(\.rawValue), ["SESSION", "TASK", "PROJECT"])
    }

    // MARK: the session detail's token

    func testSessionDetailDecodesShareToken() throws {
        let d = try decode(SessionDetail.self, #"{"id":"s1","shareToken":"tok123"}"#)
        XCTAssertEqual(d.shareToken, "tok123")
    }

    func testSessionDetailShareTokenNilWhenUnshared() throws {
        // A never-shared session omits the field (or sends null); either decodes to nil.
        let d = try decode(SessionDetail.self, #"{"id":"s2"}"#)
        XCTAssertNil(d.shareToken)
    }
}
