import Foundation
@testable import OrbitKit

/// Watches the way `GET /watches` sends them — a JSON object through the real decoder — so no test
/// can hold a shape the wire never has. Ids default to short stand-ins; the tests about id spellings
/// pass real public ids.
enum WatchFixture {
    /// The clock every projection test reads against.
    static let now = ISO8601DateFormatter().date(from: "2026-09-14T10:00:00Z")!

    /// A timestamp `seconds` before `now`; a negative number is after it.
    static func ago(_ seconds: TimeInterval) -> String {
        iso.string(from: now.addingTimeInterval(-seconds))
    }

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func all(_ leaf: String) -> [String: Any] {
        ["kind": "ALL", "over": "ALL_TARGETS", "leaf": leaf]
    }

    static func any(_ leaf: String) -> [String: Any] {
        ["kind": "ANY", "over": "ALL_TARGETS", "leaf": leaf]
    }

    static func target(_ id: String, kind: String = "TASK", state: String = "OBSERVED") -> [String: Any] {
        ["targetKind": kind, "targetResourceId": id, "state": state, "targetEpoch": 0,
         "lastEvaluatedAt": NSNull()]
    }

    /// `n` task targets, the first `met` of them SATISFIED.
    static func tasks(_ n: Int, met: Int = 0) -> [[String: Any]] {
        (0..<n).map { target("T\($0)", state: $0 < met ? "SATISFIED" : "OBSERVED") }
    }

    static func delivery(_ state: String, action: String = "RESUME_SESSION", attempts: Int = 0,
                         lastError: String? = nil) -> [String: Any] {
        ["id": "D-\(state)-\(attempts)", "action": action, "state": state, "attempts": attempts,
         "nextAttemptAt": NSNull(), "lastError": lastError.map { $0 as Any } ?? NSNull(),
         "deliveredAt": NSNull(), "deadLetteredAt": NSNull(),
         "createdAt": ago(60), "updatedAt": ago(30)]
    }

    static func match(generation: Int = 1, deliveries: [[String: Any]]) -> [String: Any] {
        let snapshot: [String: Any] = ["evaluatedAt": ago(60), "targets": [] as [Any]]
        return ["id": "M\(generation)", "generation": generation, "matchedAt": ago(60),
                "reason": "ALL TASK_TERMINAL 2/2", "predicateVersion": 1,
                "perTargetSnapshot": snapshot, "deliveries": deliveries]
    }

    /// An unmatched end's delivery: the wire flattens the delivery's own fields beside `kind`.
    static func end(_ kind: String, delivery: [String: Any]) -> [String: Any] {
        var object = delivery
        object["kind"] = kind
        object["expirySnapshot"] = NSNull()
        return object
    }

    static func watch(id: String = "W1", state: String = "ACTIVE", action: String = "RESUME_SESSION",
                      observer: String? = "S1", predicate: [String: Any] = all("TASK_TERMINAL"),
                      targets: [[String: Any]] = tasks(2), matches: [[String: Any]] = [],
                      endDeliveries: [[String: Any]] = [], generation: Int = 0,
                      lastEvaluatedAt: String? = ago(20), createdAt: String = ago(600),
                      expiresAt: String = ago(-3_600)) -> Watch {
        let object: [String: Any] = [
            "id": id,
            "observerType": observer == nil ? "USER" : "SESSION",
            "observerSessionId": observer.map { $0 as Any } ?? NSNull(),
            "predicateVersion": 1,
            "predicate": predicate,
            "mode": "ONE_SHOT",
            "action": action,
            "state": state,
            "generation": generation,
            "expiresAt": expiresAt,
            "nextEvaluateAt": NSNull(),
            "lastEvaluatedAt": lastEvaluatedAt.map { $0 as Any } ?? NSNull(),
            "idempotencyKey": NSNull(),
            "createdAt": createdAt,
            "updatedAt": createdAt,
            "targets": targets,
            "matches": matches,
            "expiryDeliveries": endDeliveries,
        ]
        let data = try! JSONSerialization.data(withJSONObject: object)
        return try! JSONDecoder().decode(Watch.self, from: data)
    }

    /// A row exactly as a real apiserver sent it, with every field the model ignores.
    static func server(_ json: String) -> Watch {
        try! JSONDecoder().decode(Watch.self, from: Data(json.utf8))
    }

    // MARK: the turn a watch queues

    // The three shapes `watch-delivery.service.ts` writes (`watchTurnContent`,
    // `watchExpiryTurnContent`, `watchEndTurnContent`), built the way it builds them and with the
    // ids the web's own fixtures use — the server writes a watch's UUID into the text while the API
    // serves public ids, and reading one wake has to survive that.

    static let wakeWatchID = "0195c0de-0000-7000-8000-0000000000c3"
    static let wakeTaskID = "0195c0de-0000-7000-8000-0000000000d4"
    static let wakeReason = "ANY_OF(ALL TASK_TERMINAL 2/3, ANY TASK_FAILED 1/3)"
    private static let wakeMark = "This turn was queued by the watch, not typed by a person."

    /// The payload, pretty-printed in a fenced block, as `JSON.stringify(payload, null, 2)` leaves it.
    static func fenced(_ payload: [String: Any]) -> String {
        let data = try! JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted])
        return "```json\n\(String(decoding: data, as: UTF8.self))\n```"
    }

    static func change(kind: String = "TASK", id: String = wakeTaskID, state: String = "SATISFIED",
                       status: String? = "FAILED") -> [String: Any] {
        var entry: [String: Any] = ["kind": kind, "id": id, "state": state]
        if let status { entry["observed"] = ["status": status] }
        return entry
    }

    /// A Match's wake. `last` adds the line a CONTINUOUS watch's final wake carries between the head
    /// and the mark, which is why the head is read as a line and not as the whole first paragraph.
    static func matchWake(generation: Int = 1, reason: String = wakeReason,
                          changed: [[String: Any]] = [change()], watchID: String = wakeWatchID,
                          payloadWatchID: String? = nil, last: Bool = false) -> String {
        var header = ["Orbit Watch \(watchID) matched at generation \(generation): \(reason)", ""]
        if last {
            header.append("That was the last wake its budget allows: the watch has ended and will "
                          + "not wake this session again.")
            header.append("")
        }
        header.append("\(wakeMark) What the watch recorded when its condition held:")
        let payload: [String: Any] = [
            "watchId": payloadWatchID ?? watchID,
            "generation": generation,
            "matchedAt": "2026-09-14T11:59:00.000Z",
            "reason": reason,
            "changedTargets": changed,
            "latestSnapshot": ["evaluatedAt": "2026-09-14T11:59:00.000Z", "targets": [] as [Any]],
        ]
        return "\(header.joined(separator: "\n"))\n\n\(fenced(payload))"
    }

    static func expiryWake(watchID: String = wakeWatchID) -> String {
        let header = [
            "Orbit Watch \(watchID) EXPIRED at 2026-09-14T11:00:00.000Z without its condition ever holding.",
            "",
            "\(wakeMark) The watch has ended and will not wake this session again. What its last "
                + "evaluation saw:",
        ].joined(separator: "\n")
        return "\(header)\n\n\(fenced(["watchId": watchID, "state": "EXPIRED"]))"
    }

    /// A REVOKED or UNRESOLVABLE end, which names no target and carries no snapshot.
    static func endWake(_ end: String, watchID: String = wakeWatchID) -> String {
        let header = [
            "Orbit Watch \(watchID) ended \(end): every target it watched is gone, so its condition "
                + "can never be decided.",
            "",
            "\(wakeMark) The watch has ended and will not wake this session again.",
        ].joined(separator: "\n")
        return "\(header)\n\n\(fenced(["watchId": watchID, "state": end]))"
    }

    /// Captured from an apiserver built at main a8b6a0843 by the Watch integration QA (task 34DH29wQ6TIGLaPXPFlv2,
    /// `qa/artifacts/m1/m1-fixtures/watch-withdrawn.json`): a Match whose queued wake was withdrawn before a runner
    /// took it. A session_create(wait) that gets its answer inline releases its wake into the same dead letter.
    static let withdrawnWakeJSON = #"""
    {
      "id": "34Oaok4mTYwXssYuZtrVT",
      "observerType": "SESSION",
      "observerSessionId": "34OaohdITbxmALi8Uc0e8",
      "predicateVersion": 1,
      "predicate": { "kind": "ALL", "leaf": "TASK_TERMINAL", "over": "ALL_TARGETS" },
      "mode": "ONE_SHOT",
      "action": "RESUME_SESSION",
      "state": "MATCHED",
      "generation": 1,
      "debounceSeconds": null,
      "wakeBudget": null,
      "holding": true,
      "windowOpenedAt": null,
      "windowClosesAt": null,
      "windowCrossings": 0,
      "expiresAt": "2026-09-14T10:06:59.570Z",
      "nextEvaluateAt": null,
      "lastEvaluatedAt": "2026-09-14T09:06:59.570Z",
      "idempotencyKey": null,
      "createdAt": "2026-09-14T09:06:59.570Z",
      "updatedAt": "2026-09-14T09:06:59.570Z",
      "targets": [
        {
          "targetKind": "TASK",
          "targetResourceId": "34OaoimYU7A8ltmI7bR20",
          "state": "SATISFIED",
          "targetEpoch": 0,
          "lastEvaluatedAt": "2026-09-14T09:06:59.570Z",
          "targetResourcePublicId": "34OaoimYU7A8ltmI7bR20"
        }
      ],
      "matches": [
        {
          "id": "34OaokHe7NBnv0o4KO9NB",
          "generation": 1,
          "matchedAt": "2026-09-14T09:06:59.570Z",
          "reason": "ALL TASK_TERMINAL 1/1",
          "predicateVersion": 1,
          "perTargetSnapshot": {
            "targets": [
              {
                "id": "34OaoimYU7A8ltmI7bR20",
                "kind": "TASK",
                "epoch": 0,
                "state": "SATISFIED",
                "leaves": { "TASK_TERMINAL": true },
                "changed": true,
                "observed": { "status": "CANCELLED" },
                "publicId": "34OaoimYU7A8ltmI7bR20"
              }
            ],
            "evaluatedAt": "2026-09-14T09:06:59.570Z"
          },
          "deliveries": [
            {
              "id": "34OaokTFL8pJizFAA6UBK",
              "action": "RESUME_SESSION",
              "state": "DEAD_LETTER",
              "attempts": 0,
              "nextAttemptAt": "2026-09-14T09:06:59.570Z",
              "lastError": "WAKE_WITHDRAWN: the wake was withdrawn from the observer session's queue before a runner took it",
              "deliveredAt": null,
              "deadLetteredAt": "2026-09-14T09:07:02.218Z",
              "createdAt": "2026-09-14T09:06:59.821Z",
              "updatedAt": "2026-09-14T09:07:02.218Z",
              "publicId": "34OaokTFL8pJizFAA6UBK"
            }
          ],
          "publicId": "34OaokHe7NBnv0o4KO9NB"
        }
      ],
      "expiryDeliveries": [],
      "publicId": "34Oaok4mTYwXssYuZtrVT",
      "observerSessionPublicId": "34OaohdITbxmALi8Uc0e8"
    }
    """#

    /// The same capture's `watch-deadLetter.json`: a Match whose wake was refused because its observer session no
    /// longer belonged to the watch's owner.
    static let permissionRevokedJSON = #"""
    {
      "id": "34OaSJLp3jawfjGbKI8GJ",
      "observerType": "SESSION",
      "observerSessionId": "34OaSIlShOFrsffZ7e6A7",
      "predicateVersion": 1,
      "predicate": { "kind": "ALL", "leaf": "TASK_TERMINAL", "over": "ALL_TARGETS" },
      "mode": "ONE_SHOT",
      "action": "RESUME_SESSION",
      "state": "MATCHED",
      "generation": 1,
      "debounceSeconds": null,
      "wakeBudget": null,
      "holding": true,
      "windowOpenedAt": null,
      "windowClosesAt": null,
      "windowCrossings": 0,
      "expiresAt": "2026-09-14T09:52:15.031Z",
      "nextEvaluateAt": null,
      "lastEvaluatedAt": "2026-09-14T08:52:15.972Z",
      "idempotencyKey": null,
      "createdAt": "2026-09-14T08:52:15.031Z",
      "updatedAt": "2026-09-14T08:52:15.972Z",
      "targets": [
        {
          "targetKind": "TASK",
          "targetResourceId": "34OaSIxS5CsitlDZTFr4A",
          "state": "SATISFIED",
          "targetEpoch": 0,
          "lastEvaluatedAt": "2026-09-14T08:52:15.972Z",
          "targetResourcePublicId": "34OaSIxS5CsitlDZTFr4A"
        }
      ],
      "matches": [
        {
          "id": "7QkwVAba7ITZgBu2HQDFbM",
          "generation": 1,
          "matchedAt": "2026-09-14T08:52:15.972Z",
          "reason": "ALL TASK_TERMINAL 1/1",
          "predicateVersion": 1,
          "perTargetSnapshot": {
            "targets": [
              {
                "id": "34OaSIxS5CsitlDZTFr4A",
                "kind": "TASK",
                "epoch": 0,
                "state": "SATISFIED",
                "leaves": { "TASK_TERMINAL": true },
                "changed": true,
                "observed": { "status": "CANCELLED" },
                "publicId": "34OaSIxS5CsitlDZTFr4A"
              }
            ],
            "evaluatedAt": "2026-09-14T08:52:15.972Z"
          },
          "deliveries": [
            {
              "id": "3hTepmtGWlbs68R1D2ByDE",
              "action": "RESUME_SESSION",
              "state": "DEAD_LETTER",
              "attempts": 1,
              "nextAttemptAt": "2026-09-14T08:52:20.643Z",
              "lastError": "PERMISSION_REVOKED: the observer session no longer belongs to the watch's owner, so it was not woken",
              "deliveredAt": null,
              "deadLetteredAt": "2026-09-14T08:52:24.159Z",
              "createdAt": "2026-09-14T08:52:15.972Z",
              "updatedAt": "2026-09-14T08:52:24.159Z",
              "publicId": "3hTepmtGWlbs68R1D2ByDE"
            }
          ],
          "publicId": "7QkwVAba7ITZgBu2HQDFbM"
        }
      ],
      "expiryDeliveries": [],
      "publicId": "34OaSJLp3jawfjGbKI8GJ",
      "observerSessionPublicId": "34OaSIlShOFrsffZ7e6A7"
    }
    """#
}
