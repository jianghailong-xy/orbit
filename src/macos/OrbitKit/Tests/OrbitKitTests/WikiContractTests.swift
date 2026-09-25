import Foundation
import XCTest
@testable import OrbitKit

/// Holds OrbitKit's Wiki vocabulary to `contracts/wiki.contract.json`, the file every Wiki surface
/// transcribes (docs/wiki-contract.md). The TypeScript side is held to it by `wikiContract.spec.ts`;
/// nothing compiles this Swift against it, so this is what notices a kind, a state, an op or a reason
/// moving there and not here — a value that would otherwise decode as a quiet `.unknown`.
final class WikiContractTests: XCTestCase {
    private struct ContractMissing: Error, CustomStringConvertible {
        let searchedFrom: String
        var description: String {
            "contracts/wiki.contract.json was not found above \(searchedFrom). If the contract moved, "
                + "point this check at its new home — don't delete the check."
        }
    }

    /// Found by walking up from this file rather than by counting `..`. Never a skip: a check that
    /// quietly opts out is green on exactly the day the thing it guards goes missing.
    private func contract() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("contracts/wiki.contract.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                let data = try Data(contentsOf: candidate)
                return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            }
            dir.deleteLastPathComponent()
        }
        throw ContractMissing(searchedFrom: #filePath)
    }

    private func object(_ value: Any?, _ path: String) throws -> [String: Any] {
        try XCTUnwrap(value as? [String: Any], "contract has no object at \(path)")
    }

    private func strings(_ value: Any?, _ path: String) throws -> [String] {
        try XCTUnwrap(value as? [String], "contract has no string list at \(path)")
    }

    /// The values a closed set names, without the forward-compat floor.
    private func known<T: RawRepresentable & CaseIterable>(_ type: T.Type) -> [String]
        where T.RawValue == String {
        type.allCases.map(\.rawValue).filter { $0 != "unknown" }
    }

    // MARK: the closed sets

    /// Every kind storage admits — the six phase 1 writes and phase 3's `assumption`.
    func testKindsMatchTheContract() throws {
        let kinds = try object(contract()["kinds"], "kinds")
        XCTAssertEqual(Set(kinds.keys), Set(known(WikiEntryKind.self)))
        let writable = kinds.filter { (($0.value as? [String: Any])?["phase"] as? Int) == 1 }.keys
        XCTAssertEqual(Set(writable), Set(WikiLogic.kindFields.keys.map(\.rawValue)),
                       "Details draws a schema for exactly the kinds phase 1 writes")
    }

    /// The Details section walks each kind's fields in the registry's order; the registry is the
    /// contract's. (The ORDER is held to `KIND_SPECS` in `WikiCopyParityTests` — a JSON object read
    /// here keeps no key order.)
    func testEachKindsFieldsMatchTheContract() throws {
        let kinds = try object(contract()["kinds"], "kinds")
        for (kind, fields) in WikiLogic.kindFields {
            let spec = try object(kinds[kind.rawValue], "kinds.\(kind.rawValue)")
            let declared = try object(spec["fields"], "kinds.\(kind.rawValue).fields")
            XCTAssertEqual(Set(declared.keys), Set(fields), kind.rawValue)
            for (field, nested) in WikiLogic.nestedFields {
                guard let inner = declared[field] as? [String: Any] else { continue }
                let innerFields = try object(inner["fields"], "kinds.\(kind.rawValue).fields.\(field).fields")
                XCTAssertEqual(Set(innerFields.keys), Set(nested), "\(kind.rawValue).\(field)")
            }
        }
    }

    func testEntryStatusTrustAndAnchorStatesMatchTheContract() throws {
        let c = try contract()
        let states = try object(c["states"], "states")
        let entry = try object(states["entry"], "states.entry")
        XCTAssertEqual(try strings(entry["values"], "states.entry.values"), known(WikiEntryStatus.self))
        XCTAssertEqual(try strings(try object(c["trust"], "trust")["values"], "trust.values"),
                       known(WikiTrust.self))
        XCTAssertEqual(Set(try object(c["anchorStates"], "anchorStates").keys), Set(known(WikiAnchorState.self)))
        XCTAssertEqual(Set(try object(c["anchorTypes"], "anchorTypes").keys), Set(known(WikiAnchorType.self)))
        // `isEnded` is the contract's terminal set: what agents are no longer handed.
        let terminal = Set(try strings(entry["terminal"], "states.entry.terminal"))
        for status in WikiEntryStatus.allCases where status != .unknown {
            XCTAssertEqual(WikiEntry(id: "e", status: status).isEnded, terminal.contains(status.rawValue),
                           status.rawValue)
        }
    }

    func testOpsDecisionsAndChangesetsMatchTheContract() throws {
        let c = try contract()
        XCTAssertEqual(Set(try object(c["ops"], "ops").keys), Set(known(WikiOpKind.self)))
        let states = try object(c["states"], "states")
        XCTAssertEqual(try strings(try object(states["op"], "states.op")["values"], "states.op.values"),
                       known(WikiOpDecision.self))
        XCTAssertEqual(try strings(try object(states["changeset"], "states.changeset")["values"],
                                   "states.changeset.values"),
                       known(WikiChangesetStatus.self))
        XCTAssertEqual(Set(try object(c["changesetOrigins"], "changesetOrigins").keys),
                       Set(known(WikiChangesetOrigin.self)))
        XCTAssertEqual(Set(try object(c["authorKinds"], "authorKinds").keys), Set(known(WikiAuthorKind.self)))
        XCTAssertEqual(Set(try object(c["exposureChannels"], "exposureChannels").keys),
                       Set(known(WikiExposureChannel.self)))
    }

    func testSourcesMatchTheContract() throws {
        let c = try contract()
        XCTAssertEqual(Set(try object(c["sourceKinds"], "sourceKinds").keys), Set(known(WikiSourceKind.self)))
        XCTAssertEqual(try strings(try object(c["sourceStates"], "sourceStates")["values"], "sourceStates.values"),
                       known(WikiSourceState.self))
    }

    /// What the owner decides, and the four reasons Review's menu offers — in the words it shows them.
    func testDecideActionsAndRejectReasonsMatchTheContract() throws {
        let c = try contract()
        let decide = try object(try object(c["effectPolicy"], "effectPolicy")["decide"], "effectPolicy.decide")
        XCTAssertEqual(try strings(decide["actions"], "effectPolicy.decide.actions"),
                       WikiDecideAction.allCases.map(\.rawValue))
        let reasons = try object(c["rejectReasons"], "rejectReasons")
        XCTAssertEqual(Set(reasons.keys), Set(WikiRejectReason.allCases.map(\.rawValue)))
        for reason in WikiRejectReason.allCases {
            XCTAssertEqual(reasons[reason.rawValue] as? String, WikiCopy.rejectReasonLabel(reason), reason.rawValue)
        }
    }

    /// Only these are handed to agents, which is what a retired or rejected entry's card says it is not.
    func testThePushableTrustIsTheContracts() throws {
        let trust = try object(contract()["trust"], "trust")
        XCTAssertEqual(try strings(trust["pushable"], "trust.pushable"),
                       [WikiTrust.owner.rawValue, WikiTrust.confirmed.rawValue])
    }

    // MARK: the event

    /// The contract names the event Swift decodes, and the one field it carries.
    func testTheRealtimeEventIsTheOneSwiftDecodes() throws {
        let realtime = try object(contract()["realtime"], "realtime")
        XCTAssertEqual(realtime["event"] as? String, ControlEventType.wikiChanged.rawValue)
        XCTAssertEqual(try strings(realtime["payload"], "realtime.payload"), ["id"])
        let group = try XCTUnwrap(realtime["clientGroup"] as? String)
        XCTAssertTrue(group.contains("ControlEvent.wikiChanged"), "the contract says how Swift reads it: \(group)")
    }

    // MARK: the doors this client calls

    /// Every route the client calls is one the user door declares (`agentSurface.doors.user.routes`).
    func testEveryRouteTheClientCallsIsOnTheUserDoor() throws {
        let doors = try object(try object(contract()["agentSurface"], "agentSurface")["doors"], "agentSurface.doors")
        let user = try object(doors["user"], "agentSurface.doors.user")
        let routes = Set(try strings(user["routes"], "agentSurface.doors.user.routes"))
        for route in ["GET /api/wiki/spaces", "GET /api/wiki/spaces/:id", "GET /api/wiki/spaces/:id/entries",
                      "GET /api/wiki/entries/:id", "GET /api/wiki/review", "POST /api/wiki/changesets/:id/decide",
                      "POST /api/wiki/spaces/:id/changesets", "GET /api/wiki/spaces/:id/timeline",
                      "GET /api/wiki/search"] {
            XCTAssertTrue(routes.contains(route), "\(route) is not a route the user door declares: \(routes.sorted())")
        }
    }
}
