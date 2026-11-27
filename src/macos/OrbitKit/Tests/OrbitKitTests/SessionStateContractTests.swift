import Foundation
import XCTest
@testable import OrbitKit

/// Holds the Apple decoders to the additive fields and the legacy values in the wire contract.
final class SessionStateContractTests: XCTestCase {
    private struct ContractMissing: Error, CustomStringConvertible {
        let searchedFrom: String
        var description: String {
            "contracts/session-state.contract.json was not found above \(searchedFrom). If the contract moved, "
                + "point this check at its new home — don't delete the check."
        }
    }

    /// Found by walking up from this file. Never a skip: a check that opts out is green on the day its file goes.
    private func contract() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("contracts/session-state.contract.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                let data = try Data(contentsOf: candidate)
                return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            }
            dir.deleteLastPathComponent()
        }
        throw ContractMissing(searchedFrom: #filePath)
    }

    /// The four fields as each vector states them, keyed by vector id.
    private func vectors() throws -> [(id: String, fields: [String: Any])] {
        let list = try XCTUnwrap(contract()["vectors"] as? [[String: Any]], "contract has no vectors")
        return try list.map { vector in
            (try XCTUnwrap(vector["id"] as? String), try XCTUnwrap(vector["expect"] as? [String: Any]))
        }
    }

    private func object(_ json: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }

    private func data(_ object: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: object)
    }

    /// The base payload of each kind, as an older control plane sends it.
    private static let payloads: [String: String] = [
        "listRow": #"{"id":"s1","title":"Fix it","status":"AWAITING_INPUT","runStatus":"AWAITING_INPUT","runState":"AWAITING_INPUT","sessionState":"AWAITING_INPUT","lifecycleState":"OPEN","filingState":"OPEN"}"#,
        "detail": #"{"id":"s1","title":"Fix it","status":"FAILED","runStatus":"FAILED","runState":"FAILED","sessionState":"FAILED","lifecycleState":"OPEN","filingState":"OPEN"}"#,
        "sessionSummary": #"{"id":"s1","taskId":null,"title":"Fix it","status":"RUNNING","runStatus":"RUNNING","sessionState":"RUNNING","runState":"RUNNING","lifecycleState":"OPEN","filingState":"OPEN","agentId":"a1","agent":{"id":"a1","name":"builder","model":null,"effort":null},"pendingApprovals":1,"lastTurnAt":"2026-11-22T00:00:00.000Z"}"#,
        "sessionEnded": #"{"status":"CANCELLED","runStatus":"CANCELLED","sessionState":"COMPLETED","runState":"ENDED","lifecycleState":"COMPLETED","filingState":"ARCHIVED","endReason":"completed"}"#,
        "linkPreview": #"{"id":"s1","title":"Fix it","status":"PENDING","runStatus":"PENDING","runState":"QUEUED","sessionState":"QUEUED","lifecycleState":"OPEN","endReason":null,"error":"Account paused until 2099-01-01T00:00:00.000Z","retryAt":null,"engineTurnActive":false,"activity":null,"pendingApprovals":0,"waitingKind":null,"runningBgCount":0,"runningBgJobCount":0}"#,
        "guestRow": #"{"id":"s1","title":"Fix it","ownerName":"Ana","status":"AWAITING_INPUT","sessionState":"AWAITING_INPUT","lifecycleState":"OPEN","activity":"WAITING","addedAt":"2026-11-22T00:00:00.000Z","lastTurnAt":null}"#,
        "sharedHead": #"{"title":"Fix it","workspaceName":"orbit","status":"RUNNING","runStatus":"RUNNING","sessionState":"RUNNING","runState":"RUNNING","lifecycleState":"OPEN","filingState":"OPEN","createdAt":"2026-11-22T00:00:00.000Z","hasMore":false,"ownerName":"Ana","waitingOnOwner":true,"events":[]}"#,
        // A run in the task detail's sessions[]: SessionRef decodes phase, released, lastTurnOutcome, waitingOn and
        // workFinished; endReason is an old field of it, listed in the contract and not merged in here.
        "taskRun": #"{"id":"s1","title":"Fix it","status":"PENDING","runStatus":"PENDING","runState":"QUEUED","sessionState":"QUEUED","endReason":null,"createdAt":"2026-11-22T00:00:00.000Z"}"#,
        // One of GET /sessions/search's hits[]: SessionSearchHit decodes the facts; endReason is an old field of it.
        "searchHit": #"{"id":"s1","title":"Fix it","status":"AWAITING_INPUT","runStatus":"AWAITING_INPUT","sessionState":"AWAITING_INPUT","runState":"AWAITING_INPUT","lifecycleState":"OPEN","agent":null,"endReason":null,"createdAt":"2026-11-22T00:00:00.000Z","matchField":"title","snippet":null}"#,
    ]

    private func check<T: Codable>(_ type: T.Type, _ before: Data, _ after: Data,
                                   fields: [String: Any], label: String) throws {
        let decoder = JSONDecoder()
        let encoder = JSONEncoder()
        let old = try object(String(decoding: encoder.encode(decoder.decode(type, from: before)), as: UTF8.self))
        var new = try object(String(decoding: encoder.encode(decoder.decode(type, from: after)), as: UTF8.self))
        for key in ["phase", "released", "lastTurnOutcome", "waitingOn", "workFinished"] {
            XCTAssertNil(old[key], label)
            XCTAssertEqual(new.removeValue(forKey: key) as? NSObject, fields[key] as? NSObject, "\(label) / \(key)")
        }
        XCTAssertEqual(old as NSDictionary, new as NSDictionary, label)
    }

    private func check(_ kind: String, _ old: Data, _ new: Data,
                       fields: [String: Any], label: String) throws {
        switch kind {
        case "listRow": try check(Session.self, old, new, fields: fields, label: label)
        case "detail": try check(SessionDetail.self, old, new, fields: fields, label: label)
        case "sessionSummary": try check(ControlSessionSummary.self, old, new, fields: fields, label: label)
        case "sessionEnded": try check(ControlSessionEnded.self, old, new, fields: fields, label: label)
        case "linkPreview": try check(LinkPreviewSession.self, old, new, fields: fields, label: label)
        case "guestRow": try check(GuestSessionSummary.self, old, new, fields: fields, label: label)
        case "taskRun": try check(SessionRef.self, old, new, fields: fields, label: label)
        case "searchHit": try check(SessionSearchHit.self, old, new, fields: fields, label: label)
        case "sharedHead":
            let decoder = JSONDecoder()
            let before = try decoder.decode(GuestSession.self, from: old)
            let after = try decoder.decode(GuestSession.self, from: new)
            XCTAssertNil(before.state.phase, label)
            XCTAssertNil(before.state.released, label)
            XCTAssertNil(before.state.lastTurnOutcome, label)
            XCTAssertNil(before.state.waitingOn, label)
            XCTAssertNil(before.state.workFinished, label)
            XCTAssertEqual(after.state.phase?.rawValue, fields["phase"] as? String, label)
            XCTAssertEqual(after.state.released, fields["released"] as? Bool, label)
            XCTAssertEqual(after.state.lastTurnOutcome?.rawValue, fields["lastTurnOutcome"] as? String, label)
            XCTAssertEqual(after.state.waitingOn?.rawValue, fields["waitingOn"] as? String, label)
            XCTAssertEqual(after.state.workFinished, fields["workFinished"] as? Bool, label)
            XCTAssertEqual(after.state.runState, before.state.runState, label)
            XCTAssertEqual(after.state.runStatus, before.state.runStatus, label)
            XCTAssertEqual(after.state.sessionState, before.state.sessionState, label)
            XCTAssertEqual(after.state.lifecycleState, before.state.lifecycleState, label)
            XCTAssertEqual(after.state.waitingOnOwner, before.state.waitingOnOwner, label)
        default:
            XCTFail("Unhandled payload kind: \(kind)")
        }
    }

    func testEveryPayloadKindTheContractListsIsDecodedHere() throws {
        let kinds = try XCTUnwrap(contract()["payloads"] as? [String: Any], "contract has no payloads")
        XCTAssertEqual(Set(kinds.keys), Set(Self.payloads.keys))
        for (kind, entry) in kinds {
            let fields = try XCTUnwrap((entry as? [String: Any])?["fields"] as? [String], "\(kind) lists no fields")
            XCTAssertEqual(
                fields, ["phase", "released", "lastTurnOutcome", "waitingOn", "endReason", "workFinished"], kind)
        }
    }

    func testEachKindReadsTheNewFieldsAndPreservesTheLegacyFields() throws {
        let cases = try vectors()
        XCTAssertFalse(cases.isEmpty)
        for (kind, json) in Self.payloads {
            let base = try object(json)
            let without = try data(base)
            for (id, fields) in cases {
                // endReason is an old field on the kinds that already send it: listed, not merged in here.
                let with = try data(base.merging(fields.filter { $0.key != "endReason" }) { _, new in new })
                let expected = fields.filter { !($0.value is NSNull) }
                try check(kind, without, with, fields: expected, label: "\(kind) / \(id)")
            }
        }
    }

    func testUnknownAndMalformedNewFieldsDecodeAsAbsent() throws {
        let malformed: [String: Any] = [
            "phase": "FUTURE", "released": "false", "lastTurnOutcome": "FUTURE", "waitingOn": "FUTURE",
            "workFinished": "true",
        ]
        for (kind, json) in Self.payloads {
            let base = try object(json)
            try check(kind, data(base), data(base.merging(malformed) { _, new in new }),
                      fields: [:], label: kind)
        }
    }

    func testEveryPayloadDecodesWorkFinishedWhenTheServerSendsIt() throws {
        for (kind, json) in Self.payloads {
            let base = try object(json)
            for finished in [true, false] {
                let fields = ["workFinished": finished]
                let with = try data(base.merging(fields) { _, new in new })
                try check(kind, data(base), with, fields: fields, label: kind)
            }
        }
    }

    func testTheEnvelopeCarriesTheNewFieldsThroughToThePayloads() throws {
        let fields = try XCTUnwrap(vectors().first { $0.id == "waiting on an approval" }).fields
        for (type, kind) in [("session.updated", "sessionSummary"), ("session.ended", "sessionEnded")] {
            let payload = try object(try XCTUnwrap(Self.payloads[kind]))
            let envelope: [String: Any] = [
                "type": type, "sessionId": "s1", "agentId": "a1", "ts": "2026-11-22T00:00:00.000Z",
                "data": payload.merging(fields.filter { $0.key != "endReason" }) { _, new in new },
            ]
            let event = try JSONDecoder().decode(ControlEvent.self, from: data(envelope))
            if kind == "sessionSummary" {
                let summary = try XCTUnwrap(event.payload(ControlSessionSummary.self))
                XCTAssertEqual(summary.runStatus, .running)
                XCTAssertEqual(summary.phase, .running)
                XCTAssertEqual(summary.waitingOn, .person)
            } else {
                let ended = try XCTUnwrap(event.payload(ControlSessionEnded.self))
                XCTAssertEqual(ended.runStatus, .cancelled)
                XCTAssertEqual(ended.phase, .running)
                XCTAssertEqual(ended.released, false)
            }
        }
    }
}
