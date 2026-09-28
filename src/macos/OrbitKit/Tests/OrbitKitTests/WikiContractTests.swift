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
        // `isEnded` is the contract's ended set: what agents are no longer handed. A rejected lineage is
        // ended without being terminal — a reopened verdict proposes it again (revision 4).
        let ended = Set(try strings(entry["ended"], "states.entry.ended"))
        for status in WikiEntryStatus.allCases where status != .unknown {
            XCTAssertEqual(WikiEntry(id: "e", status: status).isEnded, ended.contains(status.rawValue),
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

    /// An imported file is a `note` (contract `import`, criterion 1): the entries a local model read in
    /// it cite the note, whose locator the server keeps as the file's path — and the Sources section
    /// shows that path under the word Note, as the web does (`wikiSourceRefText`).
    func testAnImportedNoteReadsAsTheFileItCameFrom() throws {
        let c = try contract()
        let imports = try object(c["import"], "import")
        XCTAssertEqual(try strings(imports["tables"], "import.tables"), ["wiki_note"])
        XCTAssertTrue(try XCTUnwrap(imports["source"] as? String).contains("Its locator is { path }"))
        let json = #"{"id":"source-1","kind":"note","ref":"34WLbvrZ2SKHshXeJhZNn","locator":{"path":"memory/prefers-chinese.md"},"quote":"Reply in Chinese","quoteVerified":true,"state":"live","tainted":false}"#
        let source = try JSONDecoder().decode(WikiSource.self, from: Data(json.utf8))
        XCTAssertEqual(source.kind, .note)
        XCTAssertEqual(WikiLogic.sourceWord(source.kind), "Note")
        XCTAssertEqual(WikiLogic.sourceRef(source), "memory/prefers-chinese.md")
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

    /// A challenge is answered Re-confirm, Amend or Retire (criterion 4): the contract's three answers,
    /// each a decide action this client sends.
    func testTheChallengeAnswersAreTheContracts() throws {
        let rules = try object(contract()["anchorRules"], "anchorRules")
        let verify = try object(rules["verify"], "anchorRules.verify")
        let answers = try object(verify["answers"], "anchorRules.verify.answers")
        XCTAssertEqual(Set(answers.keys.filter { $0 != "only" }), ["reconfirm", "amend", "retire"])
        for answer in answers.keys where answer != "only" {
            XCTAssertNotNil(WikiDecideAction(rawValue: answer), "\(answer) is no decide action this client can send")
        }
        XCTAssertEqual(try strings(verify["types"], "anchorRules.verify.types"), ["path", "symbol", "commit"])
        for type in try strings(verify["types"], "anchorRules.verify.types") {
            XCTAssertNotNil(WikiAnchorType(rawValue: type), "\(type) is no anchor type this client draws")
        }
    }

    /// Only these are handed to agents, which is what a retired or rejected entry's card says it is not:
    /// what a review mode applied is handed on as `auto`, and never as `unreviewed`.
    func testThePushableTrustIsTheContracts() throws {
        let trust = try object(contract()["trust"], "trust")
        XCTAssertEqual(try strings(trust["pushable"], "trust.pushable"),
                       [WikiTrust.owner.rawValue, WikiTrust.confirmed.rawValue, WikiTrust.auto.rawValue])
    }

    /// The review modes' two trusts are words of their own, never the forward-compat floor, and their
    /// labels are the ones the web shows (`WikiCopyParityTests` holds the two to each other).
    func testTheReviewModesTrustsDecodeAndSayAutoAndUnreviewed() throws {
        let decoded = try JSONDecoder().decode([WikiTrust].self, from: Data(#"["auto","unreviewed"]"#.utf8))
        XCTAssertEqual(decoded, [.auto, .unreviewed])
        XCTAssertEqual(WikiCopy.trustLabel(.auto), "Auto")
        XCTAssertEqual(WikiCopy.trustLabel(.unreviewed), "Unreviewed")
        let modes = try object(contract()["reviewModes"], "reviewModes")
        XCTAssertEqual(try strings(modes["values"], "reviewModes.values"), ["manual", "tiered", "automatic"])
    }

    /// Automatic's verification (revision 3): the op that waits for its verdict is a decision of its own,
    /// never the forward-compat floor, and a trail's verdict is one of the contract's four.
    func testTheVerificationDecisionAndVerdictsAreTheContracts() throws {
        let modes = try object(contract()["reviewModes"], "reviewModes")
        let verification = try object(modes["verification"], "reviewModes.verification")
        XCTAssertEqual(Array(try object(verification["verdicts"], "reviewModes.verification.verdicts").keys).sorted(),
                       known(WikiVerificationVerdict.self).sorted())
        let waiting = #"{"id":"op","decision":"verifying","verification":null}"#
        XCTAssertEqual(try JSONDecoder().decode(WikiChangesetOp.self, from: Data(waiting.utf8)).decision, .verifying)
        let verified = #"{"id":"op","decision":"rejected","decisionReason":"duplicate","verification":{"verdict":"duplicate","reason":"The space already says this.","model":"qwen3.8-27b-fp8","at":"2026-09-27T04:00:00.000Z","duplicateOf":"34VrJeVspTnzi2Ye6i8bz"}}"#
        let op = try JSONDecoder().decode(WikiChangesetOp.self, from: Data(verified.utf8))
        XCTAssertEqual(op.verification?.verdict, .duplicate)
        XCTAssertEqual(op.verification?.model, "qwen3.8-27b-fp8")
        XCTAssertEqual(op.verification?.duplicateOf, "34VrJeVspTnzi2Ye6i8bz")
        XCTAssertNil(op.verification?.evidence, "a verdict recorded before the server kept the mark")
    }

    /// Revision 4: a verdict says what its verifier could read, in the contract's two words, and the
    /// owner's Confirm and the reopening are routes of the owner's door.
    func testTheEvidenceMarkAndTheOwnersNewRoutesAreTheContracts() throws {
        let c = try contract()
        let modes = try object(c["reviewModes"], "reviewModes")
        let verification = try object(modes["verification"], "reviewModes.verification")
        let evidence = try object(verification["evidence"], "reviewModes.verification.evidence")
        XCTAssertEqual(try strings(evidence["values"], "reviewModes.verification.evidence.values"),
                       known(WikiVerificationEvidence.self))
        let capped = #"{"id":"op","decision":"auto_applied","verification":{"verdict":"unsupported","reason":"No record could be read.","model":"qwen3.8-27b-fp8","at":"2026-09-28T01:00:00.000Z","duplicateOf":null,"evidence":"unreadable"}}"#
        let op = try JSONDecoder().decode(WikiChangesetOp.self, from: Data(capped.utf8))
        XCTAssertEqual(op.verification?.evidence, .unreadable)
        let later = #"{"verdict":"supported","evidence":"partly"}"#
        XCTAssertEqual(try JSONDecoder().decode(WikiOpVerification.self, from: Data(later.utf8)).evidence, .unknown)
        let user = try object(try object(try object(c["agentSurface"], "agentSurface")["doors"], "agentSurface.doors")["user"],
                              "agentSurface.doors.user")
        let routes = Set(try strings(user["routes"], "agentSurface.doors.user.routes"))
        let confirm = try XCTUnwrap(try object(modes["entryConfirm"], "reviewModes.entryConfirm")["route"] as? String)
        XCTAssertEqual(confirm, "POST /api/wiki/entries/:id/confirm")
        XCTAssertTrue(routes.contains(confirm))
        let reopen = try XCTUnwrap(try object(verification["reopen"], "reviewModes.verification.reopen")["route"] as? String)
        XCTAssertTrue(routes.contains(reopen))
    }

    /// What an anchor is written with is exactly what the contract's anchor types name, and `type`.
    func testAnAnchorIsWrittenWithTheContractsKeys() throws {
        let types = try object(contract()["anchorTypes"], "anchorTypes")
        var keys: Set<String> = ["type"]
        for (type, spec) in types {
            keys.formUnion(try object(try object(spec, "anchorTypes.\(type)")["fields"], "anchorTypes.\(type).fields").keys)
        }
        XCTAssertEqual(WikiLogic.anchorInputKeys, keys)
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

    // MARK: maintenance

    /// A space's maintenance settings carry exactly the contract's keys, read the contract's own
    /// default as `.default` — off — and decode to it when the server sends none of them.
    func testMaintenanceSettingsAreTheContracts() throws {
        let settings = try object(try object(contract()["space"], "space")["settings"], "space.settings")
        let maintenance = try object(settings["maintenance"], "space.settings.maintenance")
        let defaults = try object(maintenance["default"], "space.settings.maintenance.default")
        XCTAssertEqual(Set(defaults.keys), Set(WikiMaintenanceSettings.CodingKeys.allCases.map(\.rawValue)))
        let data = try JSONSerialization.data(withJSONObject: defaults)
        XCTAssertEqual(try JSONDecoder().decode(WikiMaintenanceSettings.self, from: data), .default)
        XCTAssertFalse(WikiMaintenanceSettings.default.enabled, "maintenance is off until the owner turns it on")
        XCTAssertEqual(try JSONDecoder().decode(WikiMaintenanceSettings.self, from: Data("{}".utf8)), .default)
        let older = try JSONDecoder().decode(WikiSpaceSettings.self, from: Data(#"{"push":true}"#.utf8))
        XCTAssertNil(older.maintenance, "a server that predates maintenance sends none, and nothing fails to decode")
    }
}
