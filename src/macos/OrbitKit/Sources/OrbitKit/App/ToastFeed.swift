import Foundation

/// How loud a toast is — drives its icon, its tint, and whether it self-dismisses. Ported from
/// web's `SessionNoticeTone` so the same outcome reads the same on every client.
public enum ToastTone: Equatable, Sendable {
    case success, neutral, info, warning, error

    /// Web parity: an outcome you need to read twice — and usually paste somewhere — isn't taken
    /// away on a timer. It stays until the ✕.
    public var isPersistent: Bool { self == .warning || self == .error }
}

/// The four uses the toast system draws (docs/mocks/toast-system): what a toast asks of you decides
/// its shape, how long it stays, and whether anything can push it off the screen.
public enum ToastLevel: Equatable, Sendable {
    /// ① A pill: something you just did worked. Leaves on its own.
    case confirm
    /// A pill with a spinner: work under way, until the same operation's result takes its place.
    case progress
    /// ② A card: an outcome with an Undo to decide on or a diagnostic to read.
    case result
    /// ③ A tinted card: something failed or waits for you. Never on a timer, and never displaced by a
    /// toast that comes after it.
    case attention
}

/// The same branch and target the worktree bar hands to the session to resolve a failed merge.
public struct ToastMergeConflict: Equatable, Sendable {
    public let branch: String
    public let target: String

    public init(branch: String, target: String) {
        self.branch = branch
        self.target = target
    }
}

/// One toast, as the host draws it.
public struct ToastItem: Identifiable, Equatable, Sendable {
    public var id: UUID
    /// The outcome: "Accepted", "Couldn't merge into main".
    public var message: String
    /// What it happened to: the session, or an entry's title.
    public var subtitle: String?
    /// The diagnostic — for a failure, the server's own words.
    public var detail: String?
    public var tone: ToastTone
    /// SF Symbol overriding the tone's default, so a neutral outcome can still say what it was
    /// ("Moved to Trash" gets a trash can).
    public var icon: String?
    /// The session it reports on: the toast doubles as the way into it.
    public var sessionID: String?
    /// The action is reversible; the card carries Undo.
    public var canUndo: Bool
    /// Stands in for a foreground approval banner. The approval it names can be answered anywhere,
    /// including on another device, so the snapshot that notices has to clear it.
    public var awaitsApproval: Bool
    /// A merge conflict's primary action resolves it in the session instead of only opening it.
    public var mergeConflict: ToastMergeConflict?
    /// One operation's toasts share a key — "Merging into main…" and the merge's result — so the
    /// result takes the progress pill's place instead of arriving as a second toast.
    public var key: String?
    /// Work under way: drawn with a spinner until its result replaces it.
    public var inProgress: Bool

    public init(id: UUID = UUID(), message: String, subtitle: String? = nil, detail: String? = nil,
                tone: ToastTone = .success, icon: String? = nil, sessionID: String? = nil,
                canUndo: Bool = false, awaitsApproval: Bool = false, key: String? = nil,
                inProgress: Bool = false, mergeConflict: ToastMergeConflict? = nil) {
        self.id = id
        self.message = message
        self.subtitle = subtitle
        self.detail = detail
        self.tone = tone
        self.icon = icon
        self.sessionID = sessionID
        self.canUndo = canUndo
        self.awaitsApproval = awaitsApproval
        self.mergeConflict = mergeConflict
        self.key = key
        self.inProgress = inProgress
    }

    /// What it asks of you. A failure or an approval waits for you whatever else it carries; a card
    /// is only for an Undo to decide on or a diagnostic to read — an outcome that merely names its
    /// session is a pill you can tap through.
    public var level: ToastLevel {
        if tone.isPersistent { return .attention }
        if inProgress { return .progress }
        if canUndo || detail != nil { return .result }
        return .confirm
    }

    /// How long it stays when nothing replaces it; nil for the ones that wait for you. Three seconds
    /// for a confirmation — it confirms something you just did and expected — six for a card, the
    /// window web gives an Undo. A progress pill's minute is only a net under a result that never
    /// comes (the app was backgrounded mid-merge); its result normally replaces it long before.
    public var dwell: TimeInterval? {
        switch level {
        case .confirm:   return 3
        case .result:    return 6
        case .progress:  return 60
        case .attention: return nil
        }
    }

    /// Whether a tap opens something: the session it names.
    public var opens: Bool { sessionID != nil }
}

/// What is on screen: the toasts that wait for you, pinned, and the one transient toast below them.
///
/// The old host had one slot, and every toast took it — so a merge failure you hadn't read yet was
/// replaced by the "Link copied" that came a second later. Here a ③ is pinned, and only its ✕, its
/// own operation succeeding, or — for an approval — the approval being answered take it down; ①, ②
/// and progress share the one transient slot, where the newest wins.
public struct ToastFeed: Equatable, Sendable {
    /// ③ toasts, oldest first.
    public private(set) var pinned: [ToastItem] = []
    /// The one transient toast: ①, ② or progress.
    public private(set) var transient: ToastItem?
    /// The pinned toast drawn open on a phone; the others — and this one, once folded — show as a pill.
    public private(set) var expanded: ToastItem.ID?

    private struct Posted: Equatable, Sendable {
        let text: String
        let at: Date
    }
    private var lastPosted: Posted?

    public init() {}

    /// The pinned toast a phone shows — the newest — and how many wait behind it.
    public var front: ToastItem? { pinned.last }
    public var behindFront: Int { max(0, pinned.count - 1) }

    /// The toast with `id`, wherever it is.
    public func item(_ id: ToastItem.ID) -> ToastItem? {
        if transient?.id == id { return transient }
        return pinned.first { $0.id == id }
    }

    /// Puts `item` up and answers the id it is shown under, or nil when it repeats what went up under
    /// two seconds ago (two taps on Copy are one toast).
    ///
    /// A keyed toast takes the place of its operation's toast already up and keeps that toast's id,
    /// so the host animates a change of content rather than a second arrival: "Merging into main…"
    /// becomes "Merged into main" where it stands. A failure pins (its progress pill goes); a success
    /// clears its operation's earlier failure, which the retry it reports has answered.
    @discardableResult
    public mutating func post(_ item: ToastItem, at now: Date) -> ToastItem.ID? {
        let text = [item.message, item.subtitle ?? "", item.detail ?? "", "\(item.tone)"].joined(separator: "\u{1F}")
        if item.key == nil, let last = lastPosted, last.text == text, now.timeIntervalSince(last.at) < 2 {
            return nil
        }
        lastPosted = Posted(text: text, at: now)

        var item = item
        if let key = item.key {
            if let current = transient, current.key == key {
                transient = nil
                if item.level != .attention {
                    item.id = current.id
                    transient = item
                    return item.id
                }
            }
            if let index = pinned.firstIndex(where: { $0.key == key }) {
                if item.level == .attention {
                    item.id = pinned[index].id
                    pinned[index] = item
                    expanded = item.id
                    return item.id
                }
                if expanded == pinned[index].id { expanded = nil }
                pinned.remove(at: index)
            }
        }
        if item.level == .attention {
            pinned.append(item)
            expanded = item.id
        } else {
            transient = item
        }
        return item.id
    }

    /// ✕, a swipe, Undo, or following the toast into its session.
    public mutating func dismiss(_ id: ToastItem.ID) {
        if transient?.id == id { transient = nil }
        pinned.removeAll { $0.id == id }
        if expanded == id { expanded = nil }
    }

    /// A dwell running out: takes the transient toast down only if it is still the one the timer was
    /// started for — never the toast that has replaced it since.
    public mutating func expire(_ id: ToastItem.ID) {
        if transient?.id == id { transient = nil }
    }

    /// Folds an open pinned card back into its pill.
    public mutating func fold(_ id: ToastItem.ID) {
        if expanded == id { expanded = nil }
    }

    /// Opens a pinned toast's card from its pill.
    public mutating func unfold(_ id: ToastItem.ID) {
        if pinned.contains(where: { $0.id == id }) { expanded = id }
    }

    /// Takes down the approval cards whose session no longer waits for you — answered here, on
    /// another device, or ended.
    public mutating func clearApprovals(stillWaiting: Set<String>) {
        pinned.removeAll { toast in
            guard toast.awaitsApproval else { return false }
            guard let session = toast.sessionID else { return true }
            return !stillWaiting.contains(session)
        }
        if let expanded, !pinned.contains(where: { $0.id == expanded }) { self.expanded = nil }
    }
}
