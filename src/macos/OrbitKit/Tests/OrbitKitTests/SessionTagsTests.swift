import XCTest
@testable import OrbitKit

/// The session-tag model + the list's tag filter (`SessionFilter.withTag`) and "By Tag" grouping
/// (`SessionTagGrouping`). Pure logic, so it's unit-tested here rather than on a Mac.
final class SessionTagsTests: XCTestCase {

    private func tag(_ id: String, _ name: String, system: Bool, pos: Int, color: String = "#000000") -> SessionTag {
        SessionTag(id: id, name: name, color: color, isSystem: system, position: pos)
    }
    private func tagged(_ id: String, _ tags: [SessionTag]) -> Session {
        Session(id: id, title: id, status: .awaitingInput, agentId: nil, assignedRunnerId: nil,
                pendingApprovals: nil, branch: nil, updatedAt: nil, tags: tags)
    }

    // MARK: decoding

    func testSessionTagDecodesFromServerJSON() throws {
        let json = ##"{"id":"t1","name":"Bugfix","color":"#007AFF","isSystem":false,"position":7}"##
        let t = try JSONDecoder().decode(SessionTag.self, from: Data(json.utf8))
        XCTAssertEqual(t.id, "t1")
        XCTAssertEqual(t.name, "Bugfix")
        XCTAssertEqual(t.color, "#007AFF")
        XCTAssertFalse(t.isSystem)
        XCTAssertEqual(t.position, 7)
    }

    /// The list/detail payloads nest each session's applied tags; the row reads `session.tags`.
    func testSessionDecodesNestedTagsInServerOrder() throws {
        let json = """
        {"id":"s1","status":"AWAITING_INPUT","tags":[
          {"id":"red","name":"Red","color":"#FF3B30","isSystem":true,"position":0},
          {"id":"bug","name":"Bugfix","color":"#007AFF","isSystem":false,"position":7}]}
        """
        let s = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        XCTAssertEqual(s.tags?.map(\.id), ["red", "bug"])
    }

    /// An older server omits `tags` entirely — decoding must tolerate that (nil, not a throw).
    func testSessionToleratesMissingTags() throws {
        let s = try JSONDecoder().decode(Session.self, from: Data(#"{"id":"s1","status":"PENDING"}"#.utf8))
        XCTAssertNil(s.tags)
    }

    // MARK: filter

    func testWithTagKeepsOnlyMatchingSessionsInOrder() {
        let red = tag("red", "Red", system: true, pos: 0)
        let blue = tag("blue", "Blue", system: true, pos: 4)
        let s = [tagged("s1", [red]), tagged("s2", [blue]), tagged("s3", [red, blue]), tagged("s4", [])]
        XCTAssertEqual(SessionFilter.withTag(s, tagID: "red").map(\.id), ["s1", "s3"])
        XCTAssertEqual(SessionFilter.withTag(s, tagID: "blue").map(\.id), ["s2", "s3"])
        XCTAssertTrue(SessionFilter.withTag(s, tagID: "none").isEmpty)
    }

    // MARK: grouping

    /// Sections order by the library (system first, then position); each session files under its
    /// *primary* (first) tag; untagged sessions fall to a trailing "Untagged" section.
    func testTagSectionsGroupByPrimaryTagSystemFirst() {
        let red = tag("red", "Red", system: true, pos: 0)
        let blue = tag("blue", "Blue", system: true, pos: 4)
        let bug = tag("bug", "Bugfix", system: false, pos: 7)
        let s = [
            tagged("a", [blue]),
            tagged("b", [bug]),
            tagged("c", [red, bug]),   // primary = red
            tagged("d", []),           // untagged
            tagged("e", [red]),
        ]
        let out = SessionTagGrouping.sections(s)
        XCTAssertEqual(out.map { $0.tag?.id ?? "untagged" }, ["red", "blue", "bug", "untagged"])
        XCTAssertEqual(out[0].sessions.map(\.id), ["c", "e"])   // both file under red, input order kept
        XCTAssertEqual(out[1].sessions.map(\.id), ["a"])
        XCTAssertEqual(out[2].sessions.map(\.id), ["b"])
        XCTAssertNil(out[3].tag)                                 // Untagged
        XCTAssertEqual(out[3].sessions.map(\.id), ["d"])
    }

    /// A multi-tag session shows up exactly once (under its primary tag) — the deliberate divergence
    /// from Files.app, so `List` row identity/selection stays unambiguous.
    func testTagSectionsMultiTagSessionAppearsOnce() {
        let red = tag("red", "Red", system: true, pos: 0)
        let blue = tag("blue", "Blue", system: true, pos: 4)
        let out = SessionTagGrouping.sections([tagged("multi", [red, blue])])
        XCTAssertEqual(out.flatMap { $0.sessions.map(\.id) }, ["multi"])
        XCTAssertEqual(out.first?.tag?.id, "red")
    }

    func testTagSectionsNoUntaggedSectionWhenAllTagged() {
        let red = tag("red", "Red", system: true, pos: 0)
        XCTAssertEqual(SessionTagGrouping.sections([tagged("x", [red])]).map(\.id), ["red"])
    }
}
