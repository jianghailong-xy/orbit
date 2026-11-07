import Foundation
import XCTest
@testable import OrbitKit

private func event(_ type: String, data: String = "{}") -> ControlEvent {
    let json = #"{"type":"\#(type)","sessionId":"","agentId":null,"ts":"2026-11-07T08:00:00Z","data":\#(data)}"#
    return try! JSONDecoder().decode(ControlEvent.self, from: Data(json.utf8))
}

/// Where each control event goes (docs/list-freshness-design.md §4 R5): the one list it is about,
/// and no read at all for a type this client does not know. `AppModel.apply` switches on this route.
final class ControlEventRouteTests: XCTestCase {
    /// A type this client does not know reads nothing. It used to fall through to a whole Open-list
    /// read, once per event.
    func testAnUnknownTypeReadsNothing() {
        for type in ["landing.updated", "some.type.from.a.newer.server"] {
            let route = ControlEventRoute.of(event(type))
            XCTAssertEqual(route, .nothing, type)
            XCTAssertFalse(route.readsOpenList, type)
        }
        XCTAssertEqual(ControlEventRoute.of(event("notification")), .nothing, "the reserved channel reads nothing")
    }

    /// `watch.changed` names a watch: the watch list is read, and nothing else.
    func testWatchChangedReadsTheWatchList() {
        let route = ControlEventRoute.of(event("watch.changed", data: #"{"id":"w1"}"#))
        XCTAssertEqual(route, .watches)
        XCTAssertFalse(route.readsOpenList)
    }

    /// `project.criteria_decisions.changed` names a project: that project's decisions are read.
    func testCriteriaDecisionsChangedReadsThatProject() {
        let named = ControlEventRoute.of(event("project.criteria_decisions.changed", data: #"{"id":"34tKYCMLgan4tpcxkUn44"}"#))
        XCTAssertEqual(named, .projectDecisions(projectID: "34tKYCMLgan4tpcxkUn44"))
        XCTAssertFalse(named.readsOpenList)
        XCTAssertEqual(ControlEventRoute.of(event("project.criteria_decisions.changed")), .projectDecisions(projectID: nil),
                       "an event that names no project reads every loaded one")
        XCTAssertEqual(ControlEventRoute.of(event("project.criteria_decisions.changed", data: #"{"id":""}"#)),
                       .projectDecisions(projectID: nil))
    }

    /// `folder.changed` reads the folder library — which the Mac does not draw — and never the Open list.
    func testFolderChangedReadsTheFolders() {
        let route = ControlEventRoute.of(event("folder.changed", data: #"{"id":"f1"}"#))
        XCTAssertEqual(route, .folders)
        XCTAssertFalse(route.readsOpenList)
    }

    /// Only these still read the Open list whatever the row in hand: a row leaving Open, and the
    /// fields only the list query carries.
    func testOnlyTheListFieldsAndADepartureAlwaysReadTheOpenList() {
        XCTAssertEqual(ControlEventRoute.of(event("session.ended")), .sessionLeft)
        for type in ["session.error", "background.task"] {
            XCTAssertEqual(ControlEventRoute.of(event(type)), .openList, type)
        }
        XCTAssertEqual(ControlEventRoute.of(event("tag.changed")), .tags)
        let always = ["session.ended", "session.error", "background.task", "tag.changed"]
        for type in ["session.created", "session.updated", "approval.requested", "approval.resolved", "task.changed",
                     "task.list.changed", "agent.changed", "provider.changed", "project.changed",
                     "project.criteria_decisions.changed", "watch.changed", "folder.changed", "wiki.changed",
                     "notification", "sessions.list_changed"] + always {
            XCTAssertEqual(ControlEventRoute.of(event(type)).readsOpenList, always.contains(type), type)
        }
    }

    /// Every other type keeps its own list.
    func testEachLibraryEventReadsItsOwnList() {
        XCTAssertEqual(ControlEventRoute.of(event("session.created")), .sessionRow)
        XCTAssertEqual(ControlEventRoute.of(event("session.updated")), .sessionRow)
        XCTAssertEqual(ControlEventRoute.of(event("approval.requested")), .approvalRow)
        XCTAssertEqual(ControlEventRoute.of(event("approval.resolved")), .approvalRow)
        XCTAssertEqual(ControlEventRoute.of(event("task.changed")), .tasks)
        XCTAssertEqual(ControlEventRoute.of(event("task.list.changed")), .taskLists)
        XCTAssertEqual(ControlEventRoute.of(event("agent.changed")), .agents)
        XCTAssertEqual(ControlEventRoute.of(event("provider.changed")), .providers)
        XCTAssertEqual(ControlEventRoute.of(event("project.changed")), .projects)
        XCTAssertEqual(ControlEventRoute.of(event("wiki.changed")), .wiki)
    }

    /// `sessions.list_changed` (docs/realtime-control-plane-stream.md §4.8) is known: a hint for the
    /// app's poll carrying the list's version, never a read of its own.
    func testTheListHintIsKnownAndCarriesItsVersion() {
        let hint = event("sessions.list_changed", data: #"{"version":"ab12"}"#)
        XCTAssertEqual(hint.type, .sessionsListChanged)
        XCTAssertEqual(hint.payload(ControlListChanged.self), ControlListChanged(version: "ab12"))
        XCTAssertEqual(ControlEventRoute.of(hint), .listHint(version: "ab12"))
        XCTAssertFalse(ControlEventRoute.of(hint).readsOpenList, "the poll reads for it, a burst merged into one")
        XCTAssertEqual(ControlEventRoute.of(event("sessions.list_changed")), .listHint(version: nil))
    }

    /// `tag.changed` re-reads the tag library (the picker, the chips) and the Open list, whose rows draw
    /// a tag's name and color.
    func testTagChangedReadsTheTagLibrary() {
        let route = ControlEventRoute.of(event("tag.changed", data: #"{"id":"t1"}"#))
        XCTAssertEqual(route, .tags)
        XCTAssertTrue(route.readsOpenList)
    }

    /// The two types the server has sent for a while and this client did not know — they decoded to
    /// `.unknown`, which read the Open list.
    func testTheTwoServerTypesDecode() {
        XCTAssertEqual(event("watch.changed").type, .watchChanged)
        XCTAssertEqual(event("project.criteria_decisions.changed").type, .projectCriteriaDecisionsChanged)
        XCTAssertEqual(event("project.criteria_decisions.changed", data: #"{"id":"p1"}"#)
            .payload(ControlResourceChanged.self), ControlResourceChanged(id: "p1"))
    }
}
