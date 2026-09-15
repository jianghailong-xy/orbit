import Foundation

// The turn a watch queues into its observer, read back out of the text the server sent.
//
// A RESUME_SESSION watch wakes its observer by queueing a message on it (apiserver's
// `watch-delivery.service.ts`: `watchTurnContent`, `watchExpiryTurnContent`, `watchEndTurnContent`).
// Nobody typed that message, so drawing it as the person's own bubble is a lie the screen tells:
// the head line carries a raw UUID, the body is the JSON payload the agent was handed, and one wake
// fills a phone — which is exactly what the account owner photographed on 2026-09-15.
//
// The web reads the same text with `parseWatchWake` (src/web/src/lib/watches.ts) and draws it as
// `WatchWakeCard.tsx`. This is that rule for iOS and macOS, which share OrbitKit. Neither end
// compiles the other, so `WatchWakeCopyParityTests` is what holds the two to each other.

/// How the watch came to queue this turn.
public enum WatchWakeKind: String, Equatable, Sendable, CaseIterable {
    /// Its condition held.
    case matched = "MATCHED"
    /// Its deadline passed with the condition never holding.
    case expired = "EXPIRED"
    /// This account lost read access to a target, so it reports nothing about them (contract §7).
    case revoked = "REVOKED"
    /// Every target it watched was deleted, so the condition can never be decided.
    case unresolvable = "UNRESOLVABLE"
}

/// One target the wake reports moved, as its JSON payload spells it.
public struct WatchWakeTarget: Equatable, Sendable {
    public let kind: WatchTargetKind
    public let id: String
    /// The target's own watch state (SATISFIED, GONE …), when the payload carries one.
    public let state: String?
    /// The status column that evaluation read, when the payload carries one.
    public let status: String?

    public init(kind: WatchTargetKind, id: String, state: String? = nil, status: String? = nil) {
        self.kind = kind
        self.id = id
        self.state = state
        self.status = status
    }
}

/// A turn a watch queued, as its card draws it.
public struct WatchWake: Equatable, Sendable {
    /// As the turn spells it: the server writes the watch's UUID into the message text, while the
    /// API serves public ids — so match it through `PublicID.storageKey`, as `WatchIndex.find` does.
    public let watchId: String
    public let kind: WatchWakeKind
    /// Which Match this was; nil on the three ends, none of which is a match.
    public let generation: Int?
    /// The evaluator's own account of the condition (`ALL TASK_DONE 2/2`); nil on the three ends.
    public let reason: String?
    public let changedTargets: [WatchWakeTarget]
}

/// Reading the message a watch queued, and nothing else.
public enum WatchWakeText {
    /// The sentence the server puts under every wake's head line. Required, so a person who pastes
    /// a head line into the composer still gets their own bubble.
    public static let mark = "This turn was queued by the watch, not typed by a person."

    /// The head line's three forms, anchored whole: a Match, the deadline passing, and the two ends
    /// that stop a watch mid-flight.
    static let headPattern =
        "^Orbit Watch (\\S+) (?:matched at generation (\\d+): (.+)"
        + "|EXPIRED at \\S+ without its condition ever holding\\."
        + "|ended (REVOKED|UNRESOLVABLE): .+)$"

    private static let head = try? NSRegularExpression(pattern: headPattern)
    private static let fence = try? NSRegularExpression(pattern: "```json\\n(.*?)\\n```",
                                                        options: [.dotMatchesLineSeparators])

    /// The wake `text` is, or nil for anything else. All three of its parts have to be there — the
    /// head line, the sentence saying a watch queued it, and a JSON payload naming the same watch —
    /// which is what keeps a person quoting one of them out of this card.
    public static func parse(_ text: String) -> WatchWake? {
        guard text.hasPrefix("Orbit Watch "), text.contains(mark) else { return nil }
        let firstLine = text.prefix { $0 != "\n" }
        guard let head, let fence,
              let headMatch = head.firstMatch(in: String(firstLine),
                                              range: NSRange(firstLine.startIndex..., in: firstLine)),
              let watchId = group(headMatch, 1, in: String(firstLine)),
              let fenceMatch = fence.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let json = group(fenceMatch, 1, in: text),
              let payload = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
              payload["watchId"] as? String == watchId else { return nil }
        let generation = group(headMatch, 2, in: String(firstLine))
        let kind: WatchWakeKind = generation != nil
            ? .matched
            : group(headMatch, 4, in: String(firstLine)).flatMap(WatchWakeKind.init(rawValue:)) ?? .expired
        return WatchWake(watchId: watchId,
                         kind: kind,
                         generation: generation.flatMap(Int.init),
                         reason: group(headMatch, 3, in: String(firstLine)),
                         changedTargets: targets(payload["changedTargets"]))
    }

    private static func group(_ match: NSTextCheckingResult, _ index: Int, in text: String) -> String? {
        guard index < match.numberOfRanges, let range = Range(match.range(at: index), in: text) else {
            return nil
        }
        return String(text[range])
    }

    /// The payload's `changedTargets`, keeping only the entries that name a kind and an id — the
    /// rest of a payload this build can't read is left to the folded-away original.
    private static func targets(_ raw: Any?) -> [WatchWakeTarget] {
        guard let entries = raw as? [[String: Any]] else { return [] }
        return entries.compactMap { entry in
            guard let kind = entry["kind"] as? String, let id = entry["id"] as? String else { return nil }
            let observed = entry["observed"] as? [String: Any]
            return WatchWakeTarget(kind: WatchTargetKind(rawValue: kind) ?? .unknown,
                                   id: id,
                                   state: entry["state"] as? String,
                                   status: observed?["status"] as? String)
        }
    }
}

/// What the wake reads as on screen: web's `WatchWakeCard.tsx`, in the same words and the same
/// order — what happened, in plain English; what moved; a way to the watch; and the text the agent
/// actually received, folded away rather than dropped.
public enum WatchWakeCard {
    /// How many changed targets the card names before "+N more".
    public static let shownChanges = 5

    public static func title(_ kind: WatchWakeKind) -> String {
        switch kind {
        case .matched: return "Watch triggered"
        case .expired: return "Watch expired"
        case .revoked: return "Watch stopped: access lost"
        case .unresolvable: return "Watch stopped: every target is gone"
        }
    }

    /// Why the watch queued this turn: a Match's reason in plain words, and for each of the three
    /// ends the sentence saying this session will not be woken by it again.
    public static func why(_ wake: WatchWake) -> String {
        switch wake.kind {
        case .matched:
            guard let reason = wake.reason, !reason.isEmpty else { return "Its condition held." }
            return describeReason(reason)
        case .expired:
            return "Its deadline passed before its condition held. It will not wake this session again."
        case .revoked:
            return "This account can no longer read one of its targets, so it reports nothing about them."
        case .unresolvable:
            return "Every target it watched was deleted, so its condition can never be decided."
        }
    }

    /// A Match's `reason` in words. The server records it as `ALL TASK_DONE 2/2`, composed as
    /// `ANY_OF(…, …)`; this reads the counts back out — "2 of 2 done · 1 of 7 failed". A reason in
    /// any other shape, or naming a leaf this build doesn't have, is returned as it is rather than
    /// guessed at.
    public static func describeReason(_ reason: String) -> String {
        guard let counts = try? NSRegularExpression(pattern: "\\b(?:ALL|ANY) ([A-Z_]+) (\\d+)/(\\d+)") else {
            return reason
        }
        let range = NSRange(reason.startIndex..., in: reason)
        var parts: [String] = []
        for match in counts.matches(in: reason, range: range) {
            guard let leaf = slice(match, 1, in: reason), let held = slice(match, 2, in: reason),
                  let total = slice(match, 3, in: reason),
                  let word = reasonWord(WatchLeaf(rawValue: leaf) ?? .unknown) else { return reason }
            parts.append("\(held) of \(total) \(word)")
        }
        return parts.isEmpty ? reason : parts.joined(separator: " · ")
    }

    /// What a target that met a leaf did, after a count: "2 of 3 finished". Web's `LEAF_COPY.met`.
    ///
    /// Deliberately its own table and not `WatchProjection.metWord`: that one reads a LIVE card's
    /// progress, where two of the session leaves say something else on purpose ("completed or
    /// trashed", "need attention"). These words read a Match the server already recorded, and they
    /// are the ones the browser prints for the same string.
    static func reasonWord(_ leaf: WatchLeaf) -> String? {
        switch leaf {
        case .sessionTurnSettled: return "finished their turn"
        case .sessionRunTerminal: return "ended"
        case .sessionLifecycleTerminal: return "filed away"
        case .sessionNeedsAttention: return "asked for approval"
        case .taskTerminal: return "finished"
        case .taskDone: return "done"
        case .taskFailed: return "failed"
        case .unknown: return nil
        }
    }

    /// One changed target's line: "Task 34Oaoim is now DONE", or the title where this client holds
    /// one — a name is the whole reason the card is worth reading on a phone, and the browser has
    /// no such cache to read from.
    public static func changedLine(_ target: WatchWakeTarget, name: String? = nil) -> String {
        let noun = target.kind == .session ? "Session" : "Task"
        let shown = name.flatMap { $0.isEmpty ? nil : $0 } ?? String(target.id.prefix(8))
        guard let status = target.status, !status.isEmpty else { return "\(noun) \(shown)" }
        return "\(noun) \(shown) is now \(status)"
    }

    /// The targets this card names, and how many it leaves to `WatchProjection.moreTargets`.
    public static func changes(_ wake: WatchWake) -> (shown: [WatchWakeTarget], more: Int) {
        let shown = Array(wake.changedTargets.prefix(shownChanges))
        return (shown, wake.changedTargets.count - shown.count)
    }

    /// "Queued by a watch, not typed by you · generation 1 · 4m ago".
    public static func meta(_ wake: WatchWake, ts: String? = nil, now: Date = Date()) -> String {
        var line = "Queued by a watch, not typed by you"
        if let generation = wake.generation { line += " · generation \(generation)" }
        if let ts, let relative = RelativeTime.format(ts, now: now) { line += " · \(relative)" }
        return line
    }

    /// The runner never confirmed the engine received the turn.
    public static let undelivered = "The session has not confirmed it received this."

    /// The way to the watch itself, and the fold the original text stays behind.
    public static let viewWatch = "View watch"
    public static let rawSummary = "What the agent received"
}

/// A wake still waiting behind the running turn. The card is the same one; only the foot changes.
///
/// Withdrawing it is not Cancel: nobody typed these words, so nothing folds back into the composer,
/// and the server dead-letters the watch's delivery (`WAKE_WITHDRAWN`) rather than holding it — this
/// session is not woken this time and the watch does not send it again. That is why it asks first.
public enum WatchWakeQueue {
    public static let status = "Queued for next turn"
    public static let withdraw = "Withdraw wake"
    public static let consequence =
        "If withdrawn, this session is not woken this time, and the watch won't send it again."
    public static let confirmTitle = "Withdraw this wake?"
    public static let keep = "Keep it queued"
}

private func slice(_ match: NSTextCheckingResult, _ index: Int, in text: String) -> String? {
    guard index < match.numberOfRanges, let range = Range(match.range(at: index), in: text) else {
        return nil
    }
    return String(text[range])
}
