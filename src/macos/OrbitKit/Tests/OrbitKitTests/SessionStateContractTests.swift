import Foundation
import XCTest
@testable import OrbitKit

/// Holds OrbitKit's session decoders to `contracts/session-state.contract.json` (plan step 5.1): every payload kind
/// the contract lists now carries `phase`, `released`, `lastTurnOutcome` and `waitingOn`, and no client reads them
/// yet. So each decoder must take a payload with the four fields present — every value the contract's vectors
/// give them — and decode it to exactly what it decodes without them: the old fields read as before, and nothing
/// fails on the new keys. The TypeScript side is held to the same file by `sessionStateContract.spec.ts` and
/// `session-payloads-phase.pg.spec.ts`.
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
    ]

    /// Decodes `json` as the kind's OrbitKit type, and says whether the two payloads decode alike.
    private func decodesAlike(_ kind: String, _ without: Data, _ with: Data) throws -> Bool {
        let decoder = JSONDecoder()
        switch kind {
        case "listRow":
            return try decoder.decode(Session.self, from: without) == decoder.decode(Session.self, from: with)
        case "detail":
            return try decoder.decode(SessionDetail.self, from: without) == decoder.decode(SessionDetail.self, from: with)
        case "sessionSummary":
            return try decoder.decode(ControlSessionSummary.self, from: without)
                == decoder.decode(ControlSessionSummary.self, from: with)
        case "sessionEnded":
            return try decoder.decode(ControlSessionEnded.self, from: without)
                == decoder.decode(ControlSessionEnded.self, from: with)
        case "linkPreview":
            return try decoder.decode(LinkPreviewSession.self, from: without)
                == decoder.decode(LinkPreviewSession.self, from: with)
        case "guestRow":
            return try decoder.decode(GuestSessionSummary.self, from: without)
                == decoder.decode(GuestSessionSummary.self, from: with)
        case "sharedHead":
            return try decoder.decode(GuestSession.self, from: without) == decoder.decode(GuestSession.self, from: with)
        default:
            XCTFail("the contract names a payload kind this test does not decode: \(kind)")
            return false
        }
    }

    func testEveryPayloadKindTheContractListsIsDecodedHere() throws {
        let kinds = try XCTUnwrap(contract()["payloads"] as? [String: Any], "contract has no payloads")
        XCTAssertEqual(Set(kinds.keys), Set(Self.payloads.keys))
        for (kind, entry) in kinds {
            let fields = try XCTUnwrap((entry as? [String: Any])?["fields"] as? [String], "\(kind) lists no fields")
            XCTAssertEqual(fields, ["phase", "released", "lastTurnOutcome", "waitingOn"], kind)
        }
    }

    func testEachKindDecodesTheNewFieldsToWhatItDecodesWithoutThem() throws {
        let cases = try vectors()
        XCTAssertFalse(cases.isEmpty)
        for (kind, json) in Self.payloads {
            let base = try object(json)
            let without = try data(base)
            for (id, fields) in cases {
                let with = try data(base.merging(fields) { _, new in new })
                XCTAssertTrue(try decodesAlike(kind, without, with), "\(kind) / \(id): the new fields changed the decode")
            }
        }
    }

    func testTheEnvelopeCarriesTheNewFieldsThroughToThePayloads() throws {
        let fields = try XCTUnwrap(vectors().first { $0.id == "waiting on an approval" }).fields
        for (type, kind) in [("session.updated", "sessionSummary"), ("session.ended", "sessionEnded")] {
            let payload = try object(try XCTUnwrap(Self.payloads[kind]))
            let envelope: [String: Any] = [
                "type": type, "sessionId": "s1", "agentId": "a1", "ts": "2026-11-22T00:00:00.000Z",
                "data": payload.merging(fields) { _, new in new },
            ]
            let event = try JSONDecoder().decode(ControlEvent.self, from: data(envelope))
            if kind == "sessionSummary" {
                XCTAssertEqual(try XCTUnwrap(event.payload(ControlSessionSummary.self)).runStatus, .running)
            } else {
                XCTAssertEqual(try XCTUnwrap(event.payload(ControlSessionEnded.self)).runStatus, .cancelled)
            }
        }
    }
}
