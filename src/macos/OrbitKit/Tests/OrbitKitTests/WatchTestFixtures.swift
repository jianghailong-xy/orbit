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
}
