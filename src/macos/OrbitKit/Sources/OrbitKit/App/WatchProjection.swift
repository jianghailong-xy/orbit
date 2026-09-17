import Foundation

// How a watch reads on a card, a Following row and a session header: who is being watched, for
// what, how fresh that reading is, and what happens when the condition holds — answered without
// opening anything. Pure (`now` is injectable) and English, like the rest of the app's strings.
//
// None of the Background process vocabulary on purpose (contract §9.2): a watch is a row on the
// control plane, not a process, and a session waiting on one is "Watching", not "Background process
// running". Real shells and dev servers keep that tray.

/// Where a watch's targets stand.
public struct WatchProgress: Equatable, Sendable {
    /// Targets a leaf the condition names holds for (SATISFIED).
    public let met: Int
    /// Targets still in the set: everything but GONE.
    public let live: Int
    /// Targets whose rows were deleted — out of the set, never counted as met (contract §4).
    public let gone: Int

    public init(_ targets: [WatchTarget]) {
        met = targets.filter { $0.state == .satisfied }.count
        gone = targets.filter { $0.state == .gone }.count
        live = targets.count - gone
    }
}

/// How far to trust the progress a card shows.
public enum WatchFreshness: Equatable, Sendable {
    /// Looked at recently enough that evaluation is keeping up.
    case fresh
    /// ACTIVE and not looked at for longer than a working evaluator ever leaves it (see `staleAfter`).
    case stale
    /// ACTIVE, just created, and not looked at yet.
    case pending
    /// Not evaluated by design: paused or ended.
    case idle

    /// Every live watch is scheduled at most one reconciliation period (60s) ahead and claimed under a
    /// 60s lease (apiserver `watch-evaluator.service.ts`), so three minutes without a look means
    /// evaluation isn't happening rather than that it's slow.
    public static let staleAfter: TimeInterval = 180

    public static func of(_ watch: Watch, now: Date = Date()) -> WatchFreshness {
        guard watch.state == .active else { return .idle }
        guard let looked = watch.lastEvaluatedAt.flatMap(RelativeTime.parse) else {
            let created = RelativeTime.parse(watch.createdAt) ?? now
            return now.timeIntervalSince(created) > staleAfter ? .stale : .pending
        }
        return now.timeIntervalSince(looked) > staleAfter ? .stale : .fresh
    }
}

/// Why a watch belongs under Needs attention. A watch that can't go on watching has to say so
/// (contract §3), and a dead letter has to be visible.
public enum WatchAttention: Equatable, Sendable {
    /// A delivery gave up, with the error it kept.
    case deliveryFailed(String?)
    /// A delivery failed and is being retried; how many attempts have failed so far.
    case deliveryRetrying(failedAttempts: Int)
    /// Access to a target was withdrawn, so the watch stopped without reporting on them.
    case revoked
    /// Every target was deleted, so the condition can never be decided.
    case unresolvable
    /// It ran out with nobody told: no session waits on a NOTIFY_USER watch, so no end of it is delivered.
    case expiredUnheard
    /// ACTIVE, but evaluation isn't keeping up.
    case stale

    public var text: String {
        switch self {
        case .deliveryFailed(let error):
            guard let error, !error.isEmpty else { return "Delivery failed" }
            return "Delivery failed: \(error)"
        case .deliveryRetrying(let failed):
            return "Delivery retrying · \(failed) of \(WatchLimits.maxDeliveryAttempts) attempts failed"
        case .revoked:
            return "Stopped: access to its targets was revoked"
        case .unresolvable:
            return "Stopped: every target was deleted"
        case .expiredUnheard:
            return "Expired before its condition held: no notification was sent"
        case .stale:
            return "Not evaluated recently"
        }
    }
}

/// The Following page's sections, in display order.
public enum WatchGroup: String, CaseIterable, Sendable {
    case needsAttention, active, history

    public var title: String {
        switch self {
        case .needsAttention: return "Needs attention"
        case .active: return "Active"
        case .history: return "History"
        }
    }
}

/// One non-empty section of the Following page.
public struct WatchSection: Equatable, Sendable, Identifiable {
    public let group: WatchGroup
    public let watches: [Watch]
    public var id: WatchGroup { group }
}

public enum WatchProjection {
    // MARK: grouping

    /// Every delivery the watch caused: its Matches', then its end's.
    public static func deliveries(of watch: Watch) -> [WatchDelivery] {
        watch.matches.flatMap(\.deliveries) + watch.expiryDeliveries.map(\.delivery)
    }

    /// Why this watch is somebody's to look at, in the order the card says it. An ended watch is filed by the
    /// contract's `attention` rule (`WatchAttentionRule`, `WatchDeadLetter.needsAttention`) — the same rule
    /// `GET /watches?needsAttention=true` reads by, so a watch the server hands back under that read is one this
    /// puts under Needs attention. `.stale` is this client's own reading of a watch that is still live.
    public static func attention(for watch: Watch, now: Date = Date()) -> [WatchAttention] {
        let all = deliveries(of: watch)
        var reasons: [WatchAttention] = []
        if let failed = all.last(where: WatchDeadLetter.needsAttention) {
            reasons.append(.deliveryFailed(failed.lastError))
        }
        if let retrying = all.last(where: { ($0.state == .pending || $0.state == .inFlight) && $0.attempts > 0 }) {
            reasons.append(.deliveryRetrying(failedAttempts: retrying.attempts))
        }
        if watch.state == .revoked { reasons.append(.revoked) }
        if watch.state == .unresolvable { reasons.append(.unresolvable) }
        if watch.state == .expired, WatchAttentionRule.expiredActions.contains(watch.action) {
            reasons.append(.expiredUnheard)
        }
        if WatchFreshness.of(watch, now: now) == .stale { reasons.append(.stale) }
        return reasons
    }

    public static func group(of watch: Watch, now: Date = Date()) -> WatchGroup {
        if !attention(for: watch, now: now).isEmpty { return .needsAttention }
        return WatchStateMachine.isLive(watch.state) ? .active : .history
    }

    /// The non-empty sections in display order, each keeping the order `watches` came in.
    public static func sections(_ watches: [Watch], now: Date = Date()) -> [WatchSection] {
        let grouped = Dictionary(grouping: watches) { group(of: $0, now: now) }
        return WatchGroup.allCases.compactMap { g in
            guard let members = grouped[g], !members.isEmpty else { return nil }
            return WatchSection(group: g, watches: members)
        }
    }

    // MARK: copy

    /// "Watching 7 targets" — what a session waiting on a watch reads as, in place of
    /// "Background process running".
    public static func watchingLabel(targets n: Int) -> String {
        "Watching \(targetCount(n))"
    }

    public static func targetCount(_ n: Int) -> String {
        n == 1 ? "1 target" : "\(n) targets"
    }

    /// The noun a set of targets counts in, the way the browser's `targetNoun` counts it: the one
    /// kind every target shares ("tasks", "sessions"), and "targets" whenever a watch covers more
    /// than one. The strip's middle says the same noun the card's rows do.
    public static func targetNoun(_ watches: [Watch], count: Int) -> String {
        let kinds = Set(watches.flatMap { $0.targets.map(\.targetKind) })
        let noun = kinds.count != 1 ? "target" : (kinds.contains(.task) ? "task" : "session")
        return count == 1 ? noun : "\(noun)s"
    }

    /// What one watch's condition asks for, over the targets its leaf can read: "all 4 tasks", "any
    /// 1 of 4 tasks". The count is the predicate's own — an ANY watch over four targets is done
    /// after one — so the middle of the strip line says what the wait needs, not what it covers.
    /// The browser's `thresholdLine` over `thresholdOf` reads the same, and the two agree on every
    /// condition both of them can read.
    ///
    /// A condition this build cannot read states no threshold: the line counts the targets it can
    /// see instead ("4 tasks"). `AT_LEAST` is a predicateVersion 2 quorum — grammar 1 is ALL, ANY,
    /// ALL_OF and ANY_OF, and `WatchContractTests` holds a quorum to being a term this client reads
    /// without knowing — so on the AT_LEAST watch the browser states "2 of 4 tasks" and this line
    /// can only count the four. It does **not** fall back to "all 4 tasks": that is a requirement of
    /// the line's own, said about a condition the card right beside it refuses to show, and the
    /// watch matches at two. A composite, which this build does read, keeps asking for the whole
    /// set — the browser's rule for it too.
    public static func thresholdLabel(_ predicate: WatchPredicate, targets: [WatchTarget],
                                      watches: [Watch]) -> String {
        let kind: WatchTargetKind?
        switch predicate {
        case .all(let leaf), .any(let leaf): kind = leaf.targetKind
        case .allOf, .anyOf, .unknown: kind = nil
        }
        let of = kind.map { k in targets.filter { $0.targetKind == k }.count } ?? targets.count
        let noun = targetNoun(watches, count: of)
        if of == 0 { return "no \(noun)" }
        guard predicate.isKnown else { return "\(of) \(noun)" }
        var needed = of
        if case .any = predicate, of > 0 { needed = 1 }
        if needed == of { return "all \(of) \(noun)" }
        if needed == 1 { return "any 1 of \(of) \(noun)" }
        return "\(needed) of \(of) \(noun)"
    }

    /// The card's first line.
    public static func headline(for watch: Watch) -> String {
        let live = WatchProgress(watch.targets).live
        switch watch.state {
        case .active: return watchingLabel(targets: live)
        case .paused: return "Paused · \(targetCount(live))"
        case .matched: return "Matched"
        case .expired: return "Expired"
        case .cancelled: return "Stopped"
        case .revoked: return "Access revoked"
        case .unresolvable: return "Every target is gone"
        case .unknown: return "Unknown state"
        }
    }

    /// "3 of 7 finished", plus " · 1 gone" when a target was deleted. The verb is the condition's
    /// own when it names one leaf; with several a target counts once any of them holds, so it's "met".
    /// The denominator is the threshold the condition sets, not the set itself: the targets it reads
    /// are the ones still in it, and the count is left off when one is all it takes (web's
    /// `describeProgress` over `thresholdOf`, the same two rules).
    public static func progress(for watch: Watch) -> String {
        let p = WatchProgress(watch.targets)
        let needed = threshold(watch.predicate, targets: watch.targets.filter { $0.state != .gone }).needed
        let verb = metWord(watch.predicate)
        let text = needed == 1 ? "\(p.met) \(verb)" : "\(p.met) of \(needed) \(verb)"
        return p.gone > 0 ? "\(text) · \(p.gone) gone" : text
    }

    /// The threshold the condition itself sets, over the targets it can read: how many of them have to
    /// meet the leaf (`needed`) and how many it reads at all (`of`). One target settles an ANY watch,
    /// so it is done after the first — whatever the set it covers. A composite names no one leaf, and a
    /// term this build can't read (v1's model is `.all/.any/.allOf/.anyOf/.unknown`) has no leaf to read
    /// a kind from, so both ask for the whole set: the reading a caller had before it looked at the
    /// predicate. Nothing here throws, the way `condition` says a sentence rather than failing on a
    /// condition it cannot parse. The browser's `thresholdOf` is the same two numbers.
    static func threshold(_ predicate: WatchPredicate, targets: [WatchTarget]) -> (needed: Int, of: Int) {
        let kind: WatchTargetKind?
        switch predicate {
        case .all(let leaf), .any(let leaf): kind = leaf.targetKind
        case .allOf, .anyOf, .unknown: kind = nil
        }
        let of = kind.map { k in targets.filter { $0.targetKind == k }.count } ?? targets.count
        if case .any = predicate, of > 0 { return (needed: 1, of: of) }
        return (needed: of, of: of)
    }

    static func metWord(_ predicate: WatchPredicate) -> String {
        var leaves = Set(predicate.leaves)
        // "All of these finish, or any one fails" is the canonical agent condition (contract vector
        // `all-terminal-or-any-failed`, what `task_await` sends by default) and names two leaves for
        // one set of targets. A failed task has finished, so every target it counts as met has
        // finished — and absorbing the escape leaf keeps the commonest wait of all from reading as
        // the vaguest: "0 of 1 met" beside "0 of 1 finished" on the card under it.
        if leaves == [.taskTerminal, .taskFailed] { leaves = [.taskTerminal] }
        guard leaves.count == 1, let leaf = leaves.first else { return "met" }
        switch leaf {
        case .sessionTurnSettled: return "finished their turn"
        case .sessionRunTerminal: return "ended"
        case .sessionLifecycleTerminal: return "completed or trashed"
        case .sessionNeedsAttention: return "need attention"
        case .taskTerminal: return "finished"
        case .taskFailed: return "failed"
        case .taskDone: return "done"
        case .unknown: return "met"
        }
    }

    /// The condition as a sentence: "All tasks finish, or any task fails". A watch over one target
    /// says "The task finishes" instead.
    public static func condition(_ predicate: WatchPredicate, targetCount: Int) -> String {
        let text = sentence(predicate, single: targetCount == 1, nested: false)
        return text.prefix(1).uppercased() + text.dropFirst()
    }

    private static func sentence(_ predicate: WatchPredicate, single: Bool, nested: Bool) -> String {
        switch predicate {
        case .all(let leaf):
            return clause("all", leaf, single: single)
        case .any(let leaf):
            return clause("any", leaf, single: single)
        case .allOf(let operands):
            let text = operands.map { sentence($0, single: single, nested: true) }.joined(separator: " and ")
            return nested ? "(\(text))" : text
        case .anyOf(let operands):
            let text = operands.map { sentence($0, single: single, nested: true) }.joined(separator: ", or ")
            return nested ? "(\(text))" : text
        case .unknown:
            return unknownCondition
        }
    }

    private static let unknownCondition = "a condition this version of Orbit can't show"

    private static func clause(_ quantifier: String, _ leaf: WatchLeaf, single: Bool) -> String {
        let noun: String
        switch leaf.targetKind {
        case .task: noun = "task"
        case .session: noun = "session"
        case .unknown, nil: return unknownCondition
        }
        // One target: ALL and ANY say the same thing about it.
        if single { return "the \(noun) \(verb(leaf, singular: true))" }
        return quantifier == "all" ? "all \(noun)s \(verb(leaf, singular: false))"
                                   : "any \(noun) \(verb(leaf, singular: true))"
    }

    private static func verb(_ leaf: WatchLeaf, singular: Bool) -> String {
        switch leaf {
        case .sessionTurnSettled: return singular ? "finishes its turn" : "finish their turn"
        case .sessionRunTerminal: return singular ? "ends its run" : "end their run"
        case .sessionLifecycleTerminal: return singular ? "is completed or trashed" : "are completed or trashed"
        case .sessionNeedsAttention: return singular ? "needs attention" : "need attention"
        case .taskTerminal: return singular ? "finishes" : "finish"
        case .taskFailed: return singular ? "fails" : "fail"
        case .taskDone: return singular ? "is done" : "are done"
        case .unknown: return unknownCondition
        }
    }

    /// What happens when the condition holds. `observerTitle` names the session a RESUME_SESSION
    /// watch resumes — "this session" from inside it.
    public static func action(for watch: Watch, observerTitle: String?) -> String {
        switch watch.action {
        case .notifyUser:
            return "Notify you"
        case .resumeSession:
            guard let observerTitle, !observerTitle.isEmpty else { return "Resume the waiting session" }
            return "Resume \(observerTitle)"
        case .unknown:
            return "An action this version of Orbit can't show"
        }
    }

    /// "Last evaluated 4m ago", from the watch's own last look — never the last turn.
    public static func lastEvaluated(for watch: Watch, now: Date = Date()) -> String {
        guard let iso = watch.lastEvaluatedAt, let rel = RelativeTime.format(iso, now: now) else {
            return "Not evaluated yet"
        }
        return "Last evaluated \(rel)"
    }

    /// The deadline under the card's own EXPIRES label — "in 23h", "now" — so the label isn't said
    /// twice. Web's `expiryLabel`. Nil once the deadline no longer means anything, and for an
    /// expired watch, which the strip never holds: only live watches wait there.
    public static func expiresIn(for watch: Watch, now: Date = Date()) -> String? {
        guard WatchStateMachine.isLive(watch.state), let expiresAt = RelativeTime.parse(watch.expiresAt)
        else { return nil }
        let left = expiresAt.timeIntervalSince(now)
        return left > 0 ? "in \(duration(left))" : "now"
    }

    /// The evaluator's last look under the card's UPDATED label: "checked 20s ago", web's wording.
    /// `lastEvaluated` is the same fact as a standalone sentence, for the places with no label.
    public static func checked(for watch: Watch, now: Date = Date()) -> String {
        guard let iso = watch.lastEvaluatedAt, let relative = RelativeTime.format(iso, now: now) else {
            return "never checked"
        }
        return "checked \(relative)"
    }

    /// "Expires in 23h" while the watch is live, "Expired 2h ago" once it did, nil otherwise.
    public static func deadline(for watch: Watch, now: Date = Date()) -> String? {
        guard let expiresAt = RelativeTime.parse(watch.expiresAt) else { return nil }
        if WatchStateMachine.isLive(watch.state) {
            let left = expiresAt.timeIntervalSince(now)
            return left > 0 ? "Expires in \(duration(left))" : "Expiring now"
        }
        if watch.state == .expired, let rel = RelativeTime.format(watch.expiresAt, now: now) {
            return "Expired \(rel)"
        }
        return nil
    }

    /// A span short enough for a card row: "45s", "12m", "3h 20m", "23h", "2d 4h", "12d". The
    /// browser's `formatSpan` (`src/web/src/lib/watches.ts`), value for value — it says the smaller
    /// unit too while the larger one is still small, because "3h" for both 3h20m and 3h59m is one
    /// word for two different waits. `WatchWakeCopyParityTests` holds the two ends to each other.
    static func duration(_ seconds: TimeInterval) -> String {
        let s = Int(max(0, seconds))
        if s < 60 { return "\(max(1, s))s" }
        if s < 3_600 { return "\(s / 60)m" }
        if s < 86_400 {
            let h = s / 3_600
            let m = (s % 3_600) / 60
            return h < 6 && m > 0 ? "\(h)h \(m)m" : "\(h)h"
        }
        let d = s / 86_400
        let h = (s % 86_400) / 3_600
        return d < 3 && h > 0 ? "\(d)d \(h)h" : "\(d)d"
    }

    /// The watch's latest delivery in words — what the Match (or the end) caused, and whether it got
    /// done. Nil until there is one.
    public static func deliveryStatus(for watch: Watch) -> String? {
        deliveries(of: watch).last.flatMap { deliveryStatus($0) }
    }

    /// One delivery in words. A RESUME_SESSION delivery is done once its turn is queued (§6).
    public static func deliveryStatus(_ delivery: WatchDelivery) -> String? {
        switch delivery.state {
        case .pending, .inFlight:
            return delivery.attempts > 0
                ? WatchAttention.deliveryRetrying(failedAttempts: delivery.attempts).text
                : "Delivering"
        case .delivered:
            return delivery.action == .notifyUser ? "Notification sent" : "Resume queued"
        case .deadLetter:
            // Taken back on purpose before it ran, which is no failure (`WatchDeadLetter.quietCodes`).
            guard WatchDeadLetter.needsAttention(delivery) else { return "Wake withdrawn" }
            return WatchAttention.deliveryFailed(delivery.lastError).text
        case .unknown:
            return nil
        }
    }

    /// How a RESUME_SESSION watch that never matched ended, as its history names it.
    public static func endTitle(_ kind: WatchEndDelivery.Kind) -> String {
        switch kind {
        case .expiry: return "Expired before it matched"
        case .revoked: return "Stopped: access to its targets was revoked"
        case .unresolvable: return "Stopped: every target was deleted"
        case .unknown: return "Ended"
        }
    }

    /// What Stop costs, said before it happens: CANCELLED is the one end nobody is told about (§3).
    public static func stopWarning(for watch: Watch) -> String {
        switch watch.action {
        case .resumeSession: return "The waiting session won't be resumed, and it isn't told the watch stopped."
        case .notifyUser, .unknown: return "You won't be notified when the condition holds."
        }
    }

    /// The console strip's one line and its opened rows, in the web's words (`STRIP_*` in
    /// lib/watches.ts, held to these by `WatchStripCopyParityTests`). "Watching" alone is the line's
    /// fixed label — what is watched is named beside it, where the header's word counts it.
    public static let stripLabel = "Watching"

    /// What the strip's Then row says, on the first watch only: every strip watch resumes this
    /// session, so the constant fact is said once.
    public static let stripThen = "Resume this session"

    /// The strip's way to the Following page, where Pause and Stop live.
    public static let stripManage = "Manage in Watches ›"

    /// How the strip prefixes the soonest deadline on the count line — a lone watch's own deadline
    /// needs no qualifier.
    public static let stripEarliest = "earliest "

    /// How many targets a card names before it stops counting them out, and that line. Web's
    /// `SHOWN_TARGETS` and the `+N more` beside it; the wake card counts its own changes the same way.
    public static let shownTargets = 3

    public static func moreTargets(_ hidden: Int) -> String { "+\(hidden) more" }

    /// A target by the name this client holds for it, and by kind and short id when it holds none.
    /// A card that can't name what it waits on leaves several watches looking identical, which is
    /// what sent the account owner into the detail sheet to tell them apart.
    public static func targetTitle(kind: WatchTargetKind, id: String, name: String?) -> String {
        if let name, !name.isEmpty { return name }
        switch kind {
        case .session: return "Session \(id.prefix(8))"
        case .task: return "Task \(id.prefix(8))"
        case .unknown: return id
        }
    }

    /// A target's own state word.
    public static func targetStateWord(_ state: WatchTargetState) -> String {
        switch state {
        case .observed: return "Waiting"
        case .satisfied: return "Met"
        case .gone: return "Deleted"
        case .unknown: return "Unknown"
        }
    }

    /// A control or an edit that didn't go through, as one sentence. `verb` is the control's own
    /// ("pause", "stop", "save").
    public static func failureMessage(_ error: Error, verb: String) -> String {
        // A 404 is this surface's own reading of a refusal — a watch that is gone is gone, whatever
        // the body says. Everything else is the shared prose.
        let reason: String
        if case APIError.http(status: 404, body: _) = error {
            reason = "it no longer exists"
        } else {
            reason = APIClient.failureReason(error)
        }
        return "Couldn't \(verb) the watch — \(reason)."
    }
}

/// One labelled row on a watch's card, in the words the browser labels the same row with
/// (`WatchCard.tsx`'s `<dl>`, and the strip's rows in `WatchRelations.tsx`). Only the live spellings
/// are here: the console's strip holds nothing else, so a watch never reads "Result" or "Expired"
/// there.
public enum WatchRowLabel {
    public static let watching = "Watching"
    public static let until = "Until"
    public static let progress = "Progress"
    public static let updated = "Updated"
    public static let then = "Then"
    public static let expires = "Expires"
}

/// A session as an observer: the live watches that resume it when they match. What its header,
/// list row and console card read in place of "Background process running".
public struct WatchSessionSummary: Equatable, Sendable {
    /// Live RESUME_SESSION watches whose observer is the session. Never empty.
    public let watches: [Watch]

    /// Nil when nothing live will resume the session.
    public init?(sessionID: String, watches all: [Watch]) {
        let observing = WatchIndex.observing(sessionID: sessionID, in: all)
        guard !observing.isEmpty else { return nil }
        watches = observing
    }

    /// From `WatchIndex.summariesByObserver`, which has already grouped a non-empty set.
    init(observing: [Watch]) {
        watches = observing
    }

    private var active: [Watch] { watches.filter { $0.state == .active } }

    /// "Watching 7 targets" — the targets still in the set, each counted once across the ACTIVE
    /// watches — or "Watch paused" when every one of them is paused.
    public var word: String {
        guard !active.isEmpty else { return watches.count == 1 ? "Watch paused" : "\(watches.count) watches paused" }
        var seen = Set<String>()
        for target in active.flatMap(\.targets) where target.state != .gone {
            seen.insert("\(target.targetKind.rawValue):\(PublicID.storageKey(target.targetResourceId))")
        }
        return WatchProjection.watchingLabel(targets: seen.count)
    }

    /// One watch's progress, or how many watches there are when there are several.
    public var progress: String {
        watches.count == 1 ? WatchProjection.progress(for: watches[0]) : "\(watches.count) watches"
    }

    /// The strip line's middle: the one target a lone watch over one target that still exists
    /// names, nil when the line counts instead — the web's `SessionWatchStrip` reads the same two
    /// shapes, so the parity test holds them together.
    public var lineTarget: WatchTarget? {
        watches.count == 1 && lineTargets.count == 1 ? lineTargets[0] : nil
    }

    /// The distinct targets still in the set, each counted once across every watch — the line's
    /// count branch, so two watches over the same task never read "2 targets".
    public var lineTargetCount: Int { lineTargets.count }

    /// The strip line's middle when it names no lone target: what the wait is for. One watch over a
    /// set states the threshold its own condition asks for — "all 4 tasks", "any 1 of 4 tasks" —
    /// and several watches, no one condition between them, count the targets they cover. The web's
    /// `SessionWatchStrip` reads the same two shapes, so the parity test holds them together.
    public var lineTargetWord: String {
        guard watches.count == 1 else {
            return "\(lineTargetCount) \(WatchProjection.targetNoun(watches, count: lineTargetCount))"
        }
        return WatchProjection.thresholdLabel(watches[0].predicate, targets: lineTargets, watches: watches)
    }

    private var lineTargets: [WatchTarget] {
        var seen = Set<String>()
        var targets: [WatchTarget] = []
        for target in watches.flatMap(\.targets) where target.state != .gone {
            let key = "\(target.targetKind.rawValue):\(PublicID.storageKey(target.targetResourceId))"
            if seen.insert(key).inserted { targets.append(target) }
        }
        return targets
    }

    /// How far the wait has got and how long is left, as the line reads it: "0 met · 3h left",
    /// "earliest 0 met · 4h left" — never the sentence's "in" prefix. "earliest" only when the line
    /// speaks for several watches: a lone watch has one deadline, so there is no soonest of several
    /// to qualify. Nil when no deadline parses.
    public func lineTime(now: Date = Date()) -> String? {
        let lefts = watches.compactMap { RelativeTime.parse($0.expiresAt)?.timeIntervalSince(now) }
        guard let earliest = lefts.min() else { return nil }
        let span = earliest > 0 ? "\(WatchProjection.duration(earliest)) left" : "now"
        let met = lineTargets.filter { $0.state == .satisfied }.count
        let line = "\(met) met · \(span)"
        return watches.count == 1 ? line : "\(WatchProjection.stripEarliest)\(line)"
    }

    /// The oldest last look among the ACTIVE watches — the least fresh reading is the one to show.
    /// Nil while they're all paused.
    public func lastEvaluated(now: Date = Date()) -> String? {
        guard !active.isEmpty else { return nil }
        let oldest = active.min { lookedAt($0) < lookedAt($1) }!
        return WatchProjection.lastEvaluated(for: oldest, now: now)
    }

    private func lookedAt(_ watch: Watch) -> Date {
        watch.lastEvaluatedAt.flatMap(RelativeTime.parse) ?? .distantPast
    }
}

/// Finding watches in a fetched list.
public enum WatchIndex {
    /// The live RESUME_SESSION watches that will resume this session.
    public static func observing(sessionID: String, in watches: [Watch]) -> [Watch] {
        let key = PublicID.storageKey(sessionID)
        return watches.filter { resumes($0) && $0.observerSessionId.map(PublicID.storageKey) == key }
    }

    /// Every observed session's summary, keyed by `PublicID.storageKey` of its id. Built once per
    /// fetched list, so each list row and header finds its own with one lookup instead of a scan.
    public static func summariesByObserver(_ watches: [Watch]) -> [String: WatchSessionSummary] {
        var observing: [String: [Watch]] = [:]
        for watch in watches where resumes(watch) {
            guard let observer = watch.observerSessionId else { continue }
            observing[PublicID.storageKey(observer), default: []].append(watch)
        }
        return observing.mapValues { WatchSessionSummary(observing: $0) }
    }

    /// Still live, and resumes its observer when it matches.
    private static func resumes(_ watch: Watch) -> Bool {
        WatchStateMachine.isLive(watch.state) && watch.action == .resumeSession
    }

    /// A watch by either spelling of its id: a push names its UUID, the API its public id.
    public static func find(_ id: String, in watches: [Watch]) -> Watch? {
        let key = PublicID.storageKey(id)
        return watches.first { PublicID.storageKey($0.id) == key }
    }

    /// Several fetched lists as one: each watch once (the first copy wins), newest first. The live
    /// states are fetched on their own so a long history can't push a live watch out of the
    /// server's newest 100.
    public static func merge(_ lists: [[Watch]]) -> [Watch] {
        var seen = Set<String>()
        var merged: [Watch] = []
        for watch in lists.joined() where seen.insert(PublicID.storageKey(watch.id)).inserted {
            merged.append(watch)
        }
        return merged.sorted { createdAt($0) > createdAt($1) }
    }

    /// `watches` with `updated` in place of its older copy, or added at the front if it wasn't
    /// there — what a control's answer does to the list on screen.
    public static func replacing(_ updated: Watch, in watches: [Watch]) -> [Watch] {
        let key = PublicID.storageKey(updated.id)
        guard let index = watches.firstIndex(where: { PublicID.storageKey($0.id) == key }) else {
            return [updated] + watches
        }
        var result = watches
        result[index] = updated
        return result
    }

    private static func createdAt(_ watch: Watch) -> Date {
        RelativeTime.parse(watch.createdAt) ?? .distantPast
    }
}
