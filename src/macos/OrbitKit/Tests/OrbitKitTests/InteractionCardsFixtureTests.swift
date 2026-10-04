import Foundation
import XCTest
@testable import OrbitKit

/// Shared synthetic corpus with Android. This is protocol parity, not installed iOS evidence.
final class InteractionCardsFixtureTests: XCTestCase {
    private func corpus() throws -> [String: Any] {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let file = directory.appendingPathComponent("src/shared/src/interaction-cards.fixture.json")
            if FileManager.default.fileExists(atPath: file.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
            }
            directory.deleteLastPathComponent()
        }
        throw NSError(domain: "Missing interaction card corpus", code: 1)
    }
    private func decode<T: Decodable>(_ type: T.Type, _ raw: Any) throws -> T {
        try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: raw))
    }
    func testStandingReadsAreRealOrbitKitWireModels() throws {
        let snapshot = try XCTUnwrap(corpus()["snapshot"] as? [String: Any])
        let standing = try XCTUnwrap(snapshot["standing"] as? [String: Any])
        XCTAssertNoThrow(try decode([ApprovalInfo].self, snapshot["approvals"]!))
        XCTAssertNoThrow(try decode(EvidenceDecisionQueue.self, standing["evidenceDecisions"]!))
        XCTAssertNoThrow(try decode(OwnerConfirmationView.self, standing["ownerConfirmation"]!))
        XCTAssertNoThrow(try decode(PendingCriteriaDecisionQueue.self, standing["criteriaDecisions"]!))
        XCTAssertNoThrow(try decode(StandardSetConfirmationStanding.self, standing["acceptanceConfirmation"]!))
        XCTAssertNoThrow(try decode(ProjectCriteriaDocument.self, standing["project"]!))
        XCTAssertNoThrow(try decode(ProjectOpenItemsView.self, standing["openItems"]!))
        XCTAssertNoThrow(try decode(ProjectPromotionView.self, standing["promotion"]!))
        let start = try XCTUnwrap(corpus()["startItem"] as? [String: Any])
        XCTAssertNoThrow(try decode(ProjectStartRequest.self, start["startRequest"]!))
    }
    func testSourcePreviewsCarryTheFactsAndroidRenders() throws {
        let snapshot = try XCTUnwrap(corpus()["snapshot"] as? [String: Any])
        let rows = try XCTUnwrap(snapshot["approvals"] as? [[String: Any]])
        func input(_ id: String) throws -> JSONValue { try decode(JSONValue.self, XCTUnwrap(rows.first { $0["id"] as? String == id }?["input"])) }
        let batch = try XCTUnwrap(Approvals.batchPreview(from: input("a5")))
        XCTAssertEqual(batch.taskCount, 2); XCTAssertEqual(batch.edges, 1)
        XCTAssertEqual(batch.lists, ["Cards"])
        XCTAssertEqual(batch.tasks.last?.dependsOnRefs, ["read"])
        XCTAssertEqual(Approvals.batchImpactLines(batch), ["1 waits on a prerequisite", "1 needs a manual start — nothing will trigger it"])
        let dag = try XCTUnwrap(Approvals.dagPreview(from: input("a6")))
        XCTAssertEqual(dag.ops.first?.sentence, "Answer it waits on Read the question")
        XCTAssertEqual(dag.ops.last?.noop, true)
        let blocker = try XCTUnwrap(Approvals.blockerResolvePreview(toolName: "orbit_blocker_resolve", from: input("a7")))
        XCTAssertEqual(blocker.requiredAction, "Supply review evidence.")
        XCTAssertEqual(blocker.reason, "The evidence is now linked.")
        let project = try XCTUnwrap(Approvals.createPreview(toolName: "orbit_project_create", from: input("a4p")))
        XCTAssertEqual(project.criteria, ["All cards work"])
        XCTAssertEqual(Approvals.parseQuestions(from: try input("a2")).map(\.multiSelect), [false, true])
    }
    func testDecisionBodiesRoundTripThroughTheIndependentSwiftDTOs() throws {
        let root = try corpus()
        for row in try XCTUnwrap(root["requests"] as? [[String: Any]]) {
            let verb = try XCTUnwrap(row["verb"] as? String)
            let body = try XCTUnwrap(row["body"] as? [String: Any])
            let data: Data
            switch verb {
            case "ALLOW", "DENY", "REMEMBER", "APPROVE_PLAN", "KEEP_PLANNING", "CREATE_TASK", "CREATE_BATCH", "CHANGE_DAG", "RESOLVE_BLOCKER":
                data = try JSONEncoder().encode(decode(ApprovalDecisionRequest.self, body))
            case "CONFIRM_EVIDENCE": data = try JSONEncoder().encode(decode(EvidenceDecisionRequest.self, body))
            case "APPROVE_CRITERIA", "REJECT_CRITERIA": data = try JSONEncoder().encode(decode(CriteriaDecisionRequest.self, body))
            case "CONFIRM_OWNER":
                data = try JSONEncoder().encode(OwnerDecisionRequest(decision: .confirm, requestId: "owner1", reviewRecordId: "record1", answers: [OwnerAnswerBody(key: "n1", option: 0)]))
            case "CONFIRM_MERGE": data = try JSONEncoder().encode(decode(ConfirmPromotionRequest.self, body))
            case "CONFIRM_CRITERIA": data = try JSONEncoder().encode(decode(ConfirmAcceptanceCriteriaRequest.self, body))
            case "RESUME": data = Data("{}".utf8) // This door takes no settings or raised limits.
            default: XCTFail("Unmapped shared request: \(verb)"); continue
            }
            XCTAssertEqual(try JSONSerialization.jsonObject(with: data) as? NSDictionary, body as NSDictionary, verb)
        }
    }
}
