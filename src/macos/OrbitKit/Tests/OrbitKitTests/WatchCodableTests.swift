import Foundation
import XCTest
@testable import OrbitKit

/// Pins the Watch DTOs to what `GET /watches/:id` actually sends: apiserver `WATCH_VIEW_SELECT`
/// after the public-id interceptor, so every id is the public id with a `…PublicId` twin beside it,
/// a Match nests its deliveries and snapshot, and an unmatched end is flattened into
/// `expiryDeliveries` next to its `kind`.
final class WatchCodableTests: XCTestCase {
    func testDecodesAMatchedWatchAsTheServerSendsIt() throws {
        let json = """
        {
          "id":"4ZcDj8QnWm0KxO4hQ2Hn9V","publicId":"4ZcDj8QnWm0KxO4hQ2Hn9V",
          "observerType":"SESSION","observerSessionId":"5beHmMJGwRpQhndTZImQL3",
          "observerSessionPublicId":"5beHmMJGwRpQhndTZImQL3",
          "predicateVersion":1,
          "predicate":{"kind":"ANY_OF","operands":[
            {"kind":"ALL","over":"ALL_TARGETS","leaf":"TASK_TERMINAL"},
            {"kind":"ANY","over":"ALL_TARGETS","leaf":"TASK_FAILED"}]},
          "mode":"ONE_SHOT","action":"RESUME_SESSION","state":"MATCHED","generation":1,
          "expiresAt":"2026-09-15T02:27:18.859Z","nextEvaluateAt":null,
          "lastEvaluatedAt":"2026-09-14T03:01:02.003Z","idempotencyKey":null,
          "createdAt":"2026-09-14T02:27:18.859Z","updatedAt":"2026-09-14T03:01:02.003Z",
          "targets":[
            {"targetKind":"TASK","targetResourceId":"34DGtxXdn1PcOJxwF1k2n",
             "targetResourcePublicId":"34DGtxXdn1PcOJxwF1k2n","state":"SATISFIED","targetEpoch":0,
             "lastEvaluatedAt":"2026-09-14T03:01:02.003Z"},
            {"targetKind":"TASK","targetResourceId":"34DGtxcc4kgCWg19LFgVZ","state":"GONE","targetEpoch":0,
             "lastEvaluatedAt":null}
          ],
          "matches":[{
            "id":"4ZcDj8QnWm0KxO4hQ2Hn9W","generation":1,"matchedAt":"2026-09-14T03:01:02.003Z",
            "reason":"ANY_OF(ALL TASK_TERMINAL 1/1, ANY TASK_FAILED 0/1)","predicateVersion":1,
            "perTargetSnapshot":{"evaluatedAt":"2026-09-14T03:01:02.003Z","targets":[
              {"kind":"TASK","id":"34DGtxXdn1PcOJxwF1k2n","publicId":"34DGtxXdn1PcOJxwF1k2n","epoch":0,
               "state":"SATISFIED","changed":true,"leaves":{"TASK_TERMINAL":true,"TASK_FAILED":false},
               "observed":{"status":"DONE"}},
              {"kind":"TASK","id":"34DGtxcc4kgCWg19LFgVZ","epoch":0,"state":"GONE","changed":true}
            ]},
            "deliveries":[{"id":"4ZcDj8QnWm0KxO4hQ2Hn9X","action":"RESUME_SESSION","state":"DEAD_LETTER",
              "attempts":0,"nextAttemptAt":"2026-09-14T03:01:02.003Z",
              "lastError":"OBSERVER_SESSION_ENDED: the observer's run ended",
              "deliveredAt":"2026-09-14T03:01:03.000Z","deadLetteredAt":"2026-09-14T03:05:00.000Z",
              "createdAt":"2026-09-14T03:01:02.003Z","updatedAt":"2026-09-14T03:05:00.000Z"}]
          }],
          "expiryDeliveries":[]
        }
        """
        let watch = try JSONDecoder().decode(Watch.self, from: Data(json.utf8))
        XCTAssertEqual(watch.id, "4ZcDj8QnWm0KxO4hQ2Hn9V")
        XCTAssertEqual(watch.observerType, .session)
        XCTAssertEqual(watch.observerSessionId, "5beHmMJGwRpQhndTZImQL3")
        XCTAssertEqual(watch.predicate, .anyOf([.all(.taskTerminal), .any(.taskFailed)]))
        XCTAssertEqual(watch.mode, .oneShot)
        XCTAssertEqual(watch.action, .resumeSession)
        XCTAssertEqual(watch.state, .matched)
        XCTAssertEqual(watch.generation, 1)
        XCTAssertEqual(watch.targets.map(\.state), [.satisfied, .gone])
        XCTAssertEqual(watch.targets.map(\.targetResourceId), ["34DGtxXdn1PcOJxwF1k2n", "34DGtxcc4kgCWg19LFgVZ"])
        XCTAssertNil(watch.targets[1].lastEvaluatedAt)

        let match = try XCTUnwrap(watch.matches.first)
        XCTAssertEqual(match.generation, 1)
        let seen = try XCTUnwrap(match.perTargetSnapshot?.targets)
        XCTAssertEqual(seen.first?.leaves?["TASK_TERMINAL"], true)
        XCTAssertEqual(seen.first?.observed?.status, "DONE")
        // A GONE target carries neither leaves nor observed columns.
        XCTAssertNil(seen.last?.leaves)
        XCTAssertNil(seen.last?.observed)
        XCTAssertEqual(match.deliveries.first?.state, .deadLetter)
        XCTAssertEqual(match.deliveries.first?.lastError, "OBSERVER_SESSION_ENDED: the observer's run ended")
        XCTAssertTrue(watch.expiryDeliveries.isEmpty)
    }

    /// Only an expiry carries a snapshot; a revoked watch reports nothing about its targets (§7).
    func testDecodesUnmatchedEndsWithTheDeliveryFlattenedBesideTheKind() throws {
        let json = """
        [{"kind":"EXPIRY","id":"E1","action":"RESUME_SESSION","state":"DELIVERED","attempts":1,
          "nextAttemptAt":null,"lastError":null,"deliveredAt":"2026-09-14T03:00:00.000Z","deadLetteredAt":null,
          "createdAt":"2026-09-14T02:59:00.000Z","updatedAt":"2026-09-14T03:00:00.000Z",
          "expirySnapshot":{"evaluatedAt":"2026-09-14T02:59:00.000Z","targets":[
            {"kind":"SESSION","id":"S2","epoch":0,"state":"OBSERVED","changed":false,
             "leaves":{"SESSION_TURN_SETTLED":false},
             "observed":{"status":"RUNNING","endReason":null,"runState":"RUNNING","lifecycleState":"OPEN",
                         "pendingApproval":false}}]}},
         {"kind":"REVOKED","id":"E2","action":"RESUME_SESSION","state":"PENDING","attempts":0,
          "nextAttemptAt":"2026-09-14T03:00:00.000Z","lastError":null,"deliveredAt":null,"deadLetteredAt":null,
          "createdAt":"2026-09-14T03:00:00.000Z","updatedAt":"2026-09-14T03:00:00.000Z","expirySnapshot":null}]
        """
        let ends = try JSONDecoder().decode([WatchEndDelivery].self, from: Data(json.utf8))
        XCTAssertEqual(ends.map(\.kind), [.expiry, .revoked])
        XCTAssertEqual(ends[0].delivery.id, "E1")
        XCTAssertEqual(ends[0].delivery.state, .delivered)
        XCTAssertEqual(ends[0].delivery.attempts, 1)
        let facts = try XCTUnwrap(ends[0].expirySnapshot?.targets.first?.observed)
        XCTAssertEqual(facts.runState, "RUNNING")
        XCTAssertEqual(facts.pendingApproval, false)
        XCTAssertEqual(ends[1].delivery.state, .pending)
        XCTAssertNil(ends[1].expirySnapshot)
    }

    /// A newer server's words for a state, a leaf, a term or a delivery mustn't fail the whole list.
    func testUnknownValuesDecodeToUnknownRatherThanThrowing() throws {
        let json = """
        {"id":"W9","observerType":"TEAM","observerSessionId":null,"predicateVersion":1,
         "predicate":{"kind":"ANY_OF","operands":[{"kind":"ALL","over":"ALL_TARGETS","leaf":"TASK_BLOCKED"},
                                                  {"kind":"NONE_OF","operands":[]}]},
         "mode":"CONTINUOUS_V2","action":"EMAIL","state":"SNOOZED","generation":0,
         "expiresAt":"2026-09-15T00:00:00.000Z","nextEvaluateAt":null,"lastEvaluatedAt":null,
         "createdAt":"2026-09-14T00:00:00.000Z","updatedAt":"2026-09-14T00:00:00.000Z",
         "targets":[{"targetKind":"WORKFLOW","targetResourceId":"X1","state":"PARKED","targetEpoch":2,
                     "lastEvaluatedAt":null}],
         "matches":[{"id":"M1","generation":1,"matchedAt":"2026-09-14T00:00:00.000Z","reason":"?",
                     "predicateVersion":1,"perTargetSnapshot":null,
                     "deliveries":[{"id":"D1","action":"EMAIL","state":"BOUNCED","attempts":0,"nextAttemptAt":null,
                                    "lastError":null,"deliveredAt":null,"deadLetteredAt":null,
                                    "createdAt":"2026-09-14T00:00:00.000Z","updatedAt":"2026-09-14T00:00:00.000Z"}]}],
         "expiryDeliveries":[{"kind":"DRAINED","id":"E1","action":"EMAIL","state":"PENDING","attempts":0,
                              "nextAttemptAt":null,"lastError":null,"deliveredAt":null,"deadLetteredAt":null,
                              "createdAt":"2026-09-14T00:00:00.000Z","updatedAt":"2026-09-14T00:00:00.000Z"}]}
        """
        let watch = try JSONDecoder().decode(Watch.self, from: Data(json.utf8))
        XCTAssertEqual(watch.state, .unknown)
        XCTAssertEqual(watch.observerType, .unknown)
        XCTAssertEqual(watch.mode, .unknown)
        XCTAssertEqual(watch.action, .unknown)
        XCTAssertEqual(watch.predicate, .anyOf([.all(.unknown), .unknown("NONE_OF")]))
        XCTAssertFalse(watch.predicate.isKnown)
        XCTAssertEqual(watch.targets.first?.targetKind, .unknown)
        XCTAssertEqual(watch.targets.first?.state, .unknown)
        XCTAssertEqual(watch.matches.first?.deliveries.first?.state, .unknown)
        XCTAssertEqual(watch.expiryDeliveries.first?.kind, .unknown)
        XCTAssertNil(watch.expiryDeliveries.first?.expirySnapshot)
    }

    /// v1 has one selector; an aggregation over any other set is a term this build can't read.
    func testAnAggregationOverAnotherSelectorIsUnknown() throws {
        let json = #"{"kind":"ALL","over":"FIRST_TARGET","leaf":"TASK_DONE"}"#
        XCTAssertEqual(try JSONDecoder().decode(WatchPredicate.self, from: Data(json.utf8)), .unknown("ALL"))
    }

    /// The grammar goes back out exactly as the contract spells it (docs/watch-contract.md §2.1).
    func testPredicateEncodesTheContractGrammar() throws {
        let predicate: WatchPredicate = .anyOf([.all(.taskTerminal), .any(.taskFailed)])
        let data = try JSONEncoder().encode(predicate)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["kind"] as? String, "ANY_OF")
        XCTAssertNil(object["leaf"])
        let operands = try XCTUnwrap(object["operands"] as? [[String: Any]])
        XCTAssertEqual(operands.map { $0["kind"] as? String }, ["ALL", "ANY"])
        XCTAssertEqual(operands.map { $0["over"] as? String }, ["ALL_TARGETS", "ALL_TARGETS"])
        XCTAssertEqual(operands.map { $0["leaf"] as? String }, ["TASK_TERMINAL", "TASK_FAILED"])
        XCTAssertNil(operands[0]["operands"])
        XCTAssertEqual(try JSONDecoder().decode(WatchPredicate.self, from: data), predicate)
    }

    /// PATCH leaves out what it doesn't change — an absent `ttlSeconds` keeps the deadline — and a new
    /// condition always travels with its grammar version, which the server requires.
    func testUpdateRequestLeavesOutWhatItDoesNotChange() throws {
        func keys(_ request: UpdateWatchRequest) throws -> [String: Any] {
            try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        }
        let deadline = try keys(UpdateWatchRequest(ttlSeconds: 3_600))
        XCTAssertEqual(Set(deadline.keys), ["ttlSeconds"])
        XCTAssertEqual(deadline["ttlSeconds"] as? Int, 3_600)

        let condition = try keys(UpdateWatchRequest(predicate: .all(.taskDone)))
        XCTAssertEqual(Set(condition.keys), ["predicate", "predicateVersion"])
        XCTAssertEqual(condition["predicateVersion"] as? Int, 1)
    }
}
