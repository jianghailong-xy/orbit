import Foundation

/// The Edit sheet's choices for a live watch: conditions that fit its targets, and deadlines inside
/// the contract's TTL range. Targets and action are not editable (the server keeps them as created).
public enum WatchEditing {
    /// The conditions offered for a watch over targets of this kind. Every leaf in them is one that
    /// kind is evaluated against — a mismatch is refused as TARGET_KIND_MISMATCH — and none nests
    /// deeper or wider than the contract allows.
    public static func conditions(for kind: WatchTargetKind) -> [WatchPredicate] {
        switch kind {
        case .task:
            return [
                .all(.taskTerminal),
                .anyOf([.all(.taskTerminal), .any(.taskFailed)]),
                .all(.taskDone),
                .any(.taskFailed),
            ]
        case .session:
            return [
                .all(.sessionTurnSettled),
                .anyOf([.all(.sessionTurnSettled), .any(.sessionNeedsAttention)]),
                .any(.sessionNeedsAttention),
                .all(.sessionRunTerminal),
                .all(.sessionLifecycleTerminal),
            ]
        case .unknown:
            return []
        }
    }

    /// The conditions for this watch, its current one first — even when it isn't one of the
    /// offered ones — so opening the sheet and saving changes nothing.
    public static func conditions(for watch: Watch) -> [WatchPredicate] {
        let offered = watch.targets.first.map { conditions(for: $0.targetKind) } ?? []
        guard watch.predicate.isKnown else { return offered }
        return [watch.predicate] + offered.filter { $0 != watch.predicate }
    }

    /// "Expires in" choices, in seconds. The deadline is counted from the edit.
    public static let deadlineChoices: [Int] = [3_600, 21_600, 86_400, 259_200, 604_800, 2_592_000]

    public static func deadlineTitle(_ seconds: Int) -> String {
        if seconds % 86_400 == 0 {
            let days = seconds / 86_400
            return days == 1 ? "1 day" : "\(days) days"
        }
        let hours = seconds / 3_600
        return hours == 1 ? "1 hour" : "\(hours) hours"
    }

    /// The PATCH for what the sheet changed, or nil when it changed nothing — the server refuses an
    /// empty edit, so Save stays disabled instead. A condition this build can't read is never sent.
    /// `ttlSeconds` nil keeps the current deadline.
    public static func request(for watch: Watch, condition: WatchPredicate, ttlSeconds: Int?) -> UpdateWatchRequest? {
        let changed = condition != watch.predicate && condition.isKnown ? condition : nil
        guard changed != nil || ttlSeconds != nil else { return nil }
        return UpdateWatchRequest(predicate: changed, ttlSeconds: ttlSeconds)
    }
}
